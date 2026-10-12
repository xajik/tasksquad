import Foundation
import Network
import TaskSquadCore

/// Loopback listener on Network.framework (NWListener bound to 127.0.0.1).
actor NWHTTPListener: LocalHTTPListener {
    typealias Handler = LocalHTTPServer.Handler
    private let listener: NWListener
    private let handler: Handler
    private let bodyLimit: Int
    private let queue = DispatchQueue(label: "ai.tasksquad.local-http")
    private var clients: [UUID: NWConnection] = [:]
    private var deadlines: [UUID: Task<Void, Never>] = [:]
    private var decoders: [UUID: HTTPDecodeState] = [:]
    private var ready: CheckedContinuation<UInt16, Error>?
    private var started = false
    private var stopped = false

    init(port: UInt16, bodyLimit: Int, handler: @escaping Handler) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        listener = try NWListener(using: parameters)
        self.bodyLimit = bodyLimit; self.handler = handler
    }

    deinit {
        listener.cancel()
        for connection in clients.values { connection.cancel() }
        for deadline in deadlines.values { deadline.cancel() }
    }

    func start() async throws -> UInt16 {
        guard !started else { throw ConfigurationError("HTTP listener already started") }
        started = true
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                ready = continuation
                listener.stateUpdateHandler = { [weak self] state in Task { await self?.listenerChanged(state) } }
                listener.newConnectionHandler = { [weak self] connection in Task { await self?.accept(connection) } }
                listener.start(queue: queue)
            }
        } onCancel: { Task { await self.stop() } }
    }

    private func listenerChanged(_ state: NWListener.State) {
        switch state {
        case .ready:
            if let port = listener.port?.rawValue { ready?.resume(returning: port); ready = nil }
        case .failed(let error), .waiting(let error): ready?.resume(throwing: error); ready = nil; stop()
        case .cancelled: ready?.resume(throwing: CancellationError()); ready = nil
        default: break
        }
    }

    func stop() {
        stopped = true
        listener.cancel()
        ready?.resume(throwing: CancellationError()); ready = nil
        for connection in clients.values { connection.cancel() }
        for task in deadlines.values { task.cancel() }
        clients.removeAll(); deadlines.removeAll(); decoders.removeAll()
    }

    private func accept(_ connection: NWConnection) {
        guard !stopped, clients.count < LocalHTTPServer.maxClients else { connection.cancel(); return }
        let id = UUID()
        clients[id] = connection
        decoders[id] = HTTPDecodeState()
        connection.start(queue: queue)
        deadlines[id] = Task { [weak self] in
            do { try await Task.sleep(for: LocalHTTPServer.connectionDeadline) } catch { return }
            await self?.finish(id)
        }
        receive(id, accumulated: Data())
    }

    private func receive(_ id: UUID, accumulated: Data) {
        guard let connection = clients[id] else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            Task { await self?.received(id, accumulated: accumulated, data: data, complete: complete, error: error) }
        }
    }

    private func received(_ id: UUID, accumulated: Data, data: Data?, complete: Bool, error: NWError?) async {
        guard clients[id] != nil else { return }
        if error != nil { finish(id); return }
        var buffer = accumulated
        if let data { buffer.append(data) }
        let state = decoders[id] ?? HTTPDecodeState()
        do {
            if let request = try HTTPRequestDecoder.decode(buffer, bodyLimit: bodyLimit, state: state) {
                let response = await handler(request)
                send(response, to: id)
            } else if complete { send(.init(status: 400), to: id) }
            else { receive(id, accumulated: buffer) }
        } catch let error as HTTPError { send(.init(status: error.status), to: id) }
        catch { send(.init(status: 400), to: id) }
    }

    private func send(_ response: LocalHTTPResponse, to id: UUID) {
        guard let connection = clients[id] else { return }
        connection.send(content: response.encoded, completion: .contentProcessed { [weak self] _ in
            response.onSent?()
            Task { await self?.finish(id) }
        })
    }
    private func finish(_ id: UUID) {
        clients.removeValue(forKey: id)?.cancel()
        deadlines.removeValue(forKey: id)?.cancel()
        decoders.removeValue(forKey: id)
    }
}

/// Per-connection incremental decode progress. Reused across partial reads so a
/// slow/fragmented client re-parses only newly-arrived bytes instead of the
/// entire accumulated buffer every time (see `HTTPRequestDecoder`).

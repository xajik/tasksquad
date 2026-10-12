import Foundation
import Network

/// A TerminalRelay Durable Object double: accepts the daemon's WebSocket on
/// /terminal/<session>, records its headers and binary frames, and can push
/// browser frames back.
final class RelayFixture: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "relay-fixture")
    private let lock = NSLock()
    private var connections: [NWConnection] = []
    private var received = Data()
    private var paths: [String] = []
    private let handshake: Handshake
    var port: UInt16 { listener.port?.rawValue ?? 0 }

    init() throws {
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true
        let handshake = Handshake()
        options.setClientRequestHandler(DispatchQueue(label: "relay-handshake")) { _, additional in
            handshake.headers = Dictionary(additional.map { ($0.name.lowercased(), $0.value) }) { a, _ in a }
            return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
        }
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        self.handshake = handshake
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            self.lock.lock(); self.connections.append(connection); self.lock.unlock()
            connection.start(queue: self.queue)
            self.receive(on: connection)
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
    }

    private final class Handshake: @unchecked Sendable { var headers: [String: String] = [:] }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self, error == nil else { return }
            if let data, let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata,
               metadata.opcode == .binary {
                self.lock.lock(); self.received.append(data); self.lock.unlock()
            }
            self.receive(on: connection)
        }
    }

    var bytes: Data { lock.lock(); defer { lock.unlock() }; return received }
    var connectionCount: Int { lock.lock(); defer { lock.unlock() }; return connections.count }
    /// Headers of the (latest) upgrade request; the handshake completes after the connection is accepted.
    var firstHeaders: [String: String] { handshake.headers }

    /// Sends a browser frame (JSON text) to every connected daemon socket.
    func send(_ text: String) {
        lock.lock(); let targets = connections; lock.unlock()
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "frame", metadata: [metadata])
        for connection in targets { connection.send(content: Data(text.utf8), contentContext: context, isComplete: true, completion: .idempotent) }
    }

    func stop() { listener.cancel(); lock.lock(); connections.forEach { $0.cancel() }; lock.unlock() }
}

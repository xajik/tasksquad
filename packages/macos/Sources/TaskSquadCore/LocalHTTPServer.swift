import Foundation
import Network

public struct LocalHTTPRequest: Sendable {
    public let method: String
    public let target: String
    public let headers: [String: String]
    public let body: Data
    public var components: URLComponents? { URLComponents(string: "http://localhost" + target) }
    public var path: String { components?.path ?? target }
}

public struct LocalHTTPResponse: Sendable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data
    public var onSent: (@Sendable () -> Void)?
    public init(status: Int = 200, headers: [String: String] = [:], body: Data = Data(), onSent: (@Sendable () -> Void)? = nil) {
        self.status = status; self.headers = headers; self.body = body; self.onSent = onSent
    }
    public static func json(_ value: JSONValue, status: Int = 200) -> Self {
        Self(status: status, headers: ["Content-Type": "application/json"], body: (try? JSONEncoder().encode(value)) ?? Data())
    }
    fileprivate var bytes: Data {
        let reasons = [200: "OK", 204: "No Content", 400: "Bad Request", 404: "Not Found",
                       405: "Method Not Allowed", 408: "Request Timeout", 413: "Content Too Large",
                       431: "Request Header Fields Too Large", 500: "Internal Server Error", 501: "Not Implemented", 503: "Service Unavailable"]
        var header = "HTTP/1.1 \(status) \(reasons[status] ?? "Response")\r\n"
        for (key, value) in headers.sorted(by: { $0.key < $1.key }) {
            guard !key.contains("\r"), !key.contains("\n"), !value.contains("\r"), !value.contains("\n"),
                  !["content-length", "connection"].contains(key.lowercased()) else { continue }
            header += "\(key): \(value)\r\n"
        }
        header += "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        return Data(header.utf8) + body
    }
}

/// Loopback-only HTTP/1.x server for existing provider hooks and OAuth callbacks.
/// Uses Network.framework; no embedded web server or UI runtime. One request per
/// connection bounds resource ownership and avoids ambiguity around request reuse.
public actor LocalHTTPServer {
    public typealias Handler = @Sendable (LocalHTTPRequest) async -> LocalHTTPResponse
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

    public init(port: UInt16 = 0, bodyLimit: Int = 20 * 1024 * 1024, handler: @escaping Handler) throws {
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

    public func start() async throws -> UInt16 {
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

    public func stop() {
        stopped = true
        listener.cancel()
        ready?.resume(throwing: CancellationError()); ready = nil
        for connection in clients.values { connection.cancel() }
        for task in deadlines.values { task.cancel() }
        clients.removeAll(); deadlines.removeAll(); decoders.removeAll()
    }

    private func accept(_ connection: NWConnection) {
        guard !stopped, clients.count < 128 else { connection.cancel(); return }
        let id = UUID()
        clients[id] = connection
        decoders[id] = HTTPDecodeState()
        connection.start(queue: queue)
        deadlines[id] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
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
        connection.send(content: response.bytes, completion: .contentProcessed { [weak self] _ in
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
final class HTTPDecodeState {
    fileprivate var head: HTTPRequestDecoder.Head?
    fileprivate var chunkCursor = 0
    fileprivate var chunkOutput = Data()
}

enum HTTPRequestDecoder {
    fileprivate struct Head {
        let method: String
        let target: String
        let headers: [String: String]
        let bodyStart: Int
        let contentLength: Int? // nil means Transfer-Encoding: chunked
    }

    /// `state` defaults to a fresh, one-shot instance so a single call against a
    /// complete buffer behaves exactly as a stateless decode would. Callers that
    /// receive a request across many partial reads (LocalHTTPServer) should pass
    /// the same `HTTPDecodeState` on every call for a given connection.
    static func decode(_ buffer: Data, bodyLimit: Int, state: HTTPDecodeState = HTTPDecodeState()) throws -> LocalHTTPRequest? {
        if state.head == nil {
            guard let parsed = try parseHead(buffer, bodyLimit: bodyLimit) else { return nil }
            state.head = parsed
            state.chunkCursor = parsed.bodyStart
        }
        guard let head = state.head else { return nil }
        guard let length = head.contentLength else {
            guard let body = try appendChunks(buffer, state: state, limit: bodyLimit) else { return nil }
            return LocalHTTPRequest(method: head.method, target: head.target, headers: head.headers, body: body)
        }
        guard buffer.count - head.bodyStart >= length else { return nil }
        let body = buffer[head.bodyStart..<(head.bodyStart + length)]
        return LocalHTTPRequest(method: head.method, target: head.target, headers: head.headers, body: Data(body))
    }

    private static func parseHead(_ buffer: Data, bodyLimit: Int) throws -> Head? {
        let separator = Data("\r\n\r\n".utf8)
        guard let boundary = buffer.range(of: separator) else {
            if buffer.count > 32 * 1024 { throw HTTPError(status: 431) }
            return nil
        }
        guard boundary.lowerBound <= 32 * 1024 else { throw HTTPError(status: 431) }
        guard let head = String(data: buffer[..<boundary.lowerBound], encoding: .utf8) else { throw HTTPError(status: 400) }
        let lines = head.components(separatedBy: "\r\n")
        let first = lines[0].components(separatedBy: " ")
        guard first.count == 3, first[1].hasPrefix("/"), !first[1].hasPrefix("//"),
              ["HTTP/1.0", "HTTP/1.1"].contains(first[2]) else { throw HTTPError(status: 400) }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { throw HTTPError(status: 400) }
            let key = String(line[..<colon]).lowercased()
            guard !key.isEmpty, key.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || $0 == "-" })
            else { throw HTTPError(status: 400) }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            // Reject ambiguous framing; repeated ordinary headers are joined.
            if headers[key] != nil && ["content-length", "transfer-encoding", "host"].contains(key) { throw HTTPError(status: 400) }
            headers[key] = headers[key].map { $0 + ", " + value } ?? value
        }
        if let encoding = headers["transfer-encoding"] {
            guard headers["content-length"] == nil else { throw HTTPError(status: 400) }
            guard encoding.lowercased() == "chunked" else { throw HTTPError(status: 501) }
            return Head(method: first[0], target: first[1], headers: headers, bodyStart: boundary.upperBound, contentLength: nil)
        }
        let lengthText = headers["content-length"] ?? "0"
        guard !lengthText.isEmpty, lengthText.utf8.allSatisfy({ (48...57).contains($0) }), let length = Int(lengthText)
        else { throw HTTPError(status: 400) }
        guard length <= bodyLimit else { throw HTTPError(status: 413) }
        return Head(method: first[0], target: first[1], headers: headers, bodyStart: boundary.upperBound, contentLength: length)
    }

    /// Resumes scanning from `state.chunkCursor` and appends into `state.chunkOutput`,
    /// so a chunked body spread across many reads is scanned once per byte instead
    /// of being re-scanned from the start of the body on every partial read.
    private static func appendChunks(_ buffer: Data, state: HTTPDecodeState, limit: Int) throws -> Data? {
        let newline = Data("\r\n".utf8)
        var offset = state.chunkCursor
        defer { state.chunkCursor = offset }
        while offset < buffer.count {
            guard let end = buffer.range(of: newline, in: offset..<buffer.count) else {
                if buffer.count - offset > 8192 { throw HTTPError(status: 400) }
                return nil
            }
            guard end.lowerBound - offset <= 8192,
                  let line = String(data: buffer[offset..<end.lowerBound], encoding: .utf8),
                  let sizeText = line.split(separator: ";", omittingEmptySubsequences: false).first,
                  !sizeText.isEmpty, sizeText.utf8.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }),
                  let size = Int(sizeText, radix: 16) else { throw HTTPError(status: 400) }
            offset = end.upperBound
            if size == 0 {
                // Consume bounded trailer lines but never reinterpret them as framing headers.
                let trailerStart = offset
                while true {
                    guard buffer.count - trailerStart <= 32 * 1024 else { throw HTTPError(status: 431) }
                    guard let end = buffer.range(of: newline, in: offset..<buffer.count) else { return nil }
                    if end.lowerBound == offset { return state.chunkOutput }
                    guard buffer[offset..<end.lowerBound].contains(58) else { throw HTTPError(status: 400) }
                    offset = end.upperBound
                }
            }
            guard size <= limit - state.chunkOutput.count else { throw HTTPError(status: 413) }
            guard buffer.count - offset >= size + 2 else { return nil }
            state.chunkOutput.append(buffer[offset..<offset + size])
            offset += size
            guard buffer[offset..<offset + 2] == newline else { throw HTTPError(status: 400) }
            offset += 2
        }
        return nil
    }
}

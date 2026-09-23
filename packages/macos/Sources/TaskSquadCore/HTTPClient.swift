import Foundation

public struct HTTPResult: Sendable {
    public let data: Data
    public let status: Int
    public let headers: [String: String]
    public init(data: Data, status: Int, headers: [String: String] = [:]) {
        self.data = data; self.status = status
        self.headers = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { _, new in new })
    }
    public func requireSuccess() throws {
        guard (200..<300).contains(status) else { throw HTTPError(status: status) }
    }
}

public struct HTTPError: LocalizedError, Sendable {
    public let status: Int
    public var errorDescription: String? { "HTTP \(status)" }
}

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> HTTPResult
}

public struct NativeHTTPTransport: HTTPTransport {
    private let session: URLSession
    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 60
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        session = URLSession(configuration: configuration)
    }
    public func send(_ request: URLRequest) async throws -> HTTPResult {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        let headers = Dictionary(http.allHeaderFields.map { (String(describing: $0.key), String(describing: $0.value)) },
                                 uniquingKeysWith: { _, new in new })
        return HTTPResult(data: data, status: http.statusCode, headers: headers)
    }
}

public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let value): try c.encode(value)
        case .array(let value): try c.encode(value)
        case .string(let value): try c.encode(value)
        case .number(let value): try c.encode(value)
        case .bool(let value): try c.encode(value)
        case .null: try c.encodeNil()
        }
    }
    public subscript(_ key: String) -> JSONValue? { if case .object(let object) = self { return object[key] }; return nil }
    public var string: String? { if case .string(let value) = self { return value }; return nil }
    public var number: Double? { if case .number(let value) = self { return value }; return nil }
    public var array: [JSONValue]? { if case .array(let value) = self { return value }; return nil }
    public var object: [String: JSONValue]? { if case .object(let value) = self { return value }; return nil }
}

public struct WorkerAPI: Sendable {
    public let baseURL: String
    public let transport: any HTTPTransport
    public init(baseURL: String, transport: any HTTPTransport = NativeHTTPTransport()) {
        self.baseURL = baseURL; self.transport = transport
    }
    public func request(method: String, path: String, token: String, agentID: String = "",
                        body: JSONValue? = nil, etag: String = "") throws -> URLRequest {
        guard let url = URL(string: baseURL + path), ["https", "http"].contains(url.scheme), url.host != nil
        else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = method
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if !agentID.isEmpty { request.setValue(agentID, forHTTPHeaderField: "X-TSQ-Agent") }
        if !etag.isEmpty { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return request
    }
    public func send(method: String = "POST", path: String, token: String, agentID: String = "",
                     body: JSONValue? = nil, etag: String = "", allowNotModified: Bool = false) async throws -> HTTPResult {
        let request = try request(method: method, path: path, token: token, agentID: agentID, body: body, etag: etag)
        let result = try await transport.send(request)
        if !(allowNotModified && result.status == 304) { try result.requireSuccess() }
        return result
    }
    public func batch(entries: [JSONValue], token: String, etag: String) async throws -> HTTPResult {
        try await send(path: "/daemon/heartbeat/batch", token: token, body: .object(["agents": .array(entries)]), etag: etag, allowNotModified: true)
    }
}

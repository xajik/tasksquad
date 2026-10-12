import Foundation
@_exported import TaskSquadPortalAPI

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

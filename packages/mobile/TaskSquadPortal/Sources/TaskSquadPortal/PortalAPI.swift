import Foundation

public struct PortalProject: Decodable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let role: String?
    enum CodingKeys: String, CodingKey { case id, name, role }
}

public struct PortalAgent: Decodable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let status: String?
    public let paused: Int?
    enum CodingKeys: String, CodingKey { case id, name, status, paused }
}

public struct PortalRecord: Decodable, Identifiable, Sendable {
    public let id: String
    public let teamID: String
    public let agentID: String
    public let senderID: String?
    public let status: String
    public let sessionID: String?
    public let createdAt: Double
    public let startedAt: Double?
    public let completedAt: Double?

    public var isLive: Bool { status == "pending" || status == "running" }
    public var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1_000) }
    public var sessionDate: Date? { startedAt.map { Date(timeIntervalSince1970: $0 / 1_000) } }

    enum CodingKeys: String, CodingKey {
        case id, status
        case teamID = "team_id"
        case agentID = "agent_id"
        case senderID = "sender_id"
        case sessionID = "session_id"
        case createdAt = "created_at"
        case startedAt = "started_at"
        case completedAt = "completed_at"
    }
}

public struct PortalAPIError: LocalizedError, Sendable {
    public let status: Int
    public let message: String
    public var errorDescription: String? { message }
}

public struct PortalCreateResult: Decodable, Sendable {
    public let id: String
    public let status: String
}

/// User-scoped API for the native Portal client. Auth tokens are only sent in
/// HTTPS headers; terminal WebSockets receive a short-lived, one-use ticket.
public struct PortalAPI: Sendable {
    public typealias TokenProvider = @Sendable (_ forceRefresh: Bool) async throws -> String

    public let baseURL: URL
    private let token: TokenProvider
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared, token: @escaping TokenProvider) {
        self.baseURL = baseURL
        self.session = session
        self.token = token
    }

    public func projects() async throws -> [PortalProject] {
        struct Response: Decodable { let teams: [PortalProject] }
        return try await request(["teams"], as: Response.self).teams
    }

    public func agents(projectID: String) async throws -> [PortalAgent] {
        struct Response: Decodable { let agents: [PortalAgent] }
        return try await request(["teams", projectID, "agents"], as: Response.self).agents
    }

    public func portals(projectID: String) async throws -> [PortalRecord] {
        struct Response: Decodable { let portals: [PortalRecord] }
        return try await request(["portals"], query: ["team_id": projectID], as: Response.self).portals
    }

    public func portal(id: String) async throws -> PortalRecord {
        try await request(["portals", id], as: PortalRecord.self)
    }

    @discardableResult
    public func createPortal(projectID: String, agentID: String) async throws -> PortalCreateResult {
        try await request(["portals"], method: "POST",
                          body: ["team_id": projectID, "agent_id": agentID], as: PortalCreateResult.self)
    }

    public func closePortal(id: String) async throws {
        struct Response: Decodable { let ok: Bool? }
        let _: Response = try await request(["portals", id, "close"], method: "POST", body: [String: String](), as: Response.self)
    }

    @MainActor public func terminalSession(sessionID: String) -> PortalTerminalSession {
        PortalTerminalSession(sessionID: sessionID, ticketProvider: { [self] id in
            try await terminalTicket(sessionID: id)
        }, socketURLProvider: { [self] id, ticket, replay in
            try terminalSocketURL(sessionID: id, ticket: ticket, replay: replay)
        })
    }

    public func exchangeAuthorizationCode(_ code: String, verifier: String) async throws -> MobileToken {
        struct Request: Encodable { let code: String; let code_verifier: String }
        let url = try makeURL(["mobile", "authorization", "exchange"])
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Request(code: code, code_verifier: verifier))
        let (data, response) = try await session.data(for: request)
        try requireSuccess(data, response)
        return try JSONDecoder().decode(MobileToken.self, from: data)
    }

    public func revokeCurrentToken() async throws {
        let url = try makeURL(["auth", "cli-token"])
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer " + (try await token(false)), forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        try requireSuccess(data, response)
    }

    private func terminalTicket(sessionID: String) async throws -> String {
        struct Request: Encodable { let session_id: String }
        struct Response: Decodable { let ticket: String }
        return try await request(["terminal", "ticket"], method: "POST",
                                 body: Request(session_id: sessionID), as: Response.self).ticket
    }

    private func terminalSocketURL(sessionID: String, ticket: String, replay: Bool) throws -> URL {
        var components = URLComponents(url: try makeURL(["terminal", sessionID]), resolvingAgainstBaseURL: false)!
        components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "ticket", value: ticket),
                                 URLQueryItem(name: "replay", value: replay ? "1" : "0")]
        guard let url = components.url else { throw URLError(.badURL) }
        return url
    }

    private func request<T: Decodable>(_ path: [String], method: String = "GET",
                                       query: [String: String] = [:], as type: T.Type) async throws -> T {
        try await perform(path, method: method, query: query, body: nil, as: type)
    }

    private func request<T: Decodable, Body: Encodable>(_ path: [String], method: String = "GET",
                                                         query: [String: String] = [:], body: Body, as type: T.Type) async throws -> T {
        try await perform(path, method: method, query: query, body: JSONEncoder().encode(body), as: type)
    }

    private func perform<T: Decodable>(_ path: [String], method: String,
                                       query: [String: String], body: Data?, as type: T.Type) async throws -> T {
        let url = try makeURL(path, query: query)
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        for attempt in 0...1 {
            try Task.checkCancellation()
            request.setValue("Bearer " + (try await token(attempt == 1)), forHTTPHeaderField: "Authorization")
            let (data, response) = try await session.data(for: request)
            if (response as? HTTPURLResponse)?.statusCode == 401, attempt == 0 { continue }
            try requireSuccess(data, response)
            return try JSONDecoder().decode(T.self, from: data)
        }
        throw PortalAPIError(status: 401, message: "Please sign in again.")
    }

    private func makeURL(_ path: [String], query: [String: String] = [:]) throws -> URL {
        guard ["https", "http"].contains(baseURL.scheme), baseURL.host != nil,
              baseURL.user == nil, baseURL.password == nil else { throw URLError(.badURL) }
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let encoded = try path.map { part -> String in
            guard !part.isEmpty, part != ".", part != "..",
                  let value = part.addingPercentEncoding(withAllowedCharacters: allowed) else { throw URLError(.badURL) }
            return value
        }.joined(separator: "/")
        let prefix = components.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.percentEncodedPath = prefix.isEmpty ? "/" + encoded : "/" + prefix + "/" + encoded
        components.queryItems = query.isEmpty ? nil : query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        components.fragment = nil
        guard let url = components.url else { throw URLError(.badURL) }
        return url
    }

    private func requireSuccess(_ data: Data, _ response: URLResponse) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?[
                "error"] as? String ?? "Request failed (HTTP \(status))."
            throw PortalAPIError(status: status, message: message)
        }
    }
}

public struct MobileToken: Decodable, Sendable {
    public let token: String
    public let expiresAt: Double
    enum CodingKeys: String, CodingKey { case token; case expiresAt = "expires_at" }
}

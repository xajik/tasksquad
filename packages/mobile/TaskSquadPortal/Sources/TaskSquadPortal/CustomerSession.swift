import Foundation

public struct MobileToken: Decodable, Sendable {
    public let token: String
    public let expiresAt: Double
    enum CodingKeys: String, CodingKey { case token; case expiresAt = "expires_at" }
}

/// Account and terminal endpoints shared by the iOS and macOS clients. Bearer
/// tokens travel only in HTTPS headers; terminal WebSockets get a one-use ticket.
public extension CustomerAPI {
    /// A live terminal for a task or Portal session. Tickets are minted per
    /// connection attempt, so reconnects never reuse a credential.
    @MainActor func terminalSession(sessionID: String) -> PortalTerminalSession {
        PortalTerminalSession(sessionID: sessionID, ticketProvider: { id in
            let value = try await request(["terminal", "ticket"], method: "POST", body: .object(["session_id": .string(id)]))
            guard let ticket = value["ticket"]?.string else { throw URLError(.badServerResponse) }
            return ticket
        }, socketURLProvider: { id, ticket, replay in
            try terminalSocketURL(sessionID: id, ticket: ticket, replay: replay)
        })
    }

    func terminalSocketURL(sessionID: String, ticket: String, replay: Bool) throws -> URL {
        var parts = URLComponents(url: try url(["terminal", sessionID], query: ["ticket": ticket, "replay": replay ? "1" : "0"]), resolvingAgainstBaseURL: false)!
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        guard let result = parts.url else { throw URLError(.badURL) }
        return result
    }

    /// PKCE exchange for the mobile sign-in callback; sent without a bearer token.
    func exchangeAuthorizationCode(_ code: String, verifier: String, transport: any HTTPTransport = NativeHTTPTransport()) async throws -> MobileToken {
        var request = URLRequest(url: try url(["mobile", "authorization", "exchange"]))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["code": code, "code_verifier": verifier])
        let result = try await transport.send(request)
        guard (200..<300).contains(result.status) else {
            let value = try? JSONDecoder().decode(JSONValue.self, from: result.data)
            throw CustomerAPIError(status: result.status, message: value?["error"]?.string ?? "Request failed (HTTP \(result.status)).")
        }
        return try JSONDecoder().decode(MobileToken.self, from: result.data)
    }

    func revokeCurrentToken() async throws { _ = try await data(["auth", "cli-token"], method: "DELETE") }
}

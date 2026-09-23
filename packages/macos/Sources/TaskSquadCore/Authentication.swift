import Foundation

/// Serializes token decisions and shares a pending refresh between concurrent API callers.
public actor Authentication {
    private let store: any CredentialStore
    private let transport: any HTTPTransport
    private let apiURL: String
    private let firebaseAPIKey: String
    private let now: @Sendable () -> Date
    private struct Pending {
        let id: UUID
        let forced: Bool
        let task: Task<String, Error>
    }
    private var pending: Pending?
    private var loggingOut = false
    private var credentialGeneration: UInt64 = 0

    public init(store: any CredentialStore = KeychainCredentialStore(),
                transport: any HTTPTransport = NativeHTTPTransport(), apiURL: String, firebaseAPIKey: String,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store; self.transport = transport; self.apiURL = apiURL
        self.firebaseAPIKey = firebaseAPIKey; self.now = now
    }

    public func token(forceRotation: Bool = false) async throws -> String {
        guard !loggingOut else { throw CredentialError.notLoggedIn }
        let generation = credentialGeneration
        if let existing = pending {
            let value = try await existing.task.value
            guard !loggingOut, generation == credentialGeneration else { throw CredentialError.notLoggedIn }
            // A 401 retry must not accidentally reuse a concurrent ordinary cache lookup.
            if forceRotation && !existing.forced {
                if pending?.id == existing.id { pending = nil }
                return try await token(forceRotation: true)
            }
            return value
        }
        let id = UUID()
        let task = Task { try await self.resolveToken(forceRotation: forceRotation) }
        pending = Pending(id: id, forced: forceRotation, task: task)
        defer { if pending?.id == id { pending = nil } }
        let value = try await task.value
        guard !loggingOut, generation == credentialGeneration else { throw CredentialError.notLoggedIn }
        return value
    }

    private func resolveToken(forceRotation: Bool) async throws -> String {
        guard !loggingOut else { throw CredentialError.notLoggedIn }
        if forceRotation { return try await mint(idToken: firebaseToken()) }
        if let cli = try store.read(.cliToken), !cli.isEmpty,
           let expiry = try expiry(.cliTokenExpiry), expiry > now() {
            if expiry.timeIntervalSince(now()) > 7 * 24 * 3600 { return cli }
            do { return try await mint(idToken: firebaseToken()) }
            catch { return cli } // Reference behavior: preserve a still-valid token when rotation fails.
        }
        let idToken = try await firebaseToken()
        do { return try await mint(idToken: idToken) }
        catch { return idToken }
    }

    private func firebaseToken() async throws -> String {
        let generation = credentialGeneration
        if let id = try store.read(.idToken), !id.isEmpty,
           let expiry = try expiry(.expiry), expiry > now().addingTimeInterval(300) { return id }
        guard let refresh = try store.read(.refreshToken), !refresh.isEmpty else { throw CredentialError.notLoggedIn }
        var url = URLComponents(string: "https://securetoken.googleapis.com/v1/token")!
        url.queryItems = [URLQueryItem(name: "key", value: firebaseAPIKey)]
        var request = URLRequest(url: url.url!, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let encoded = refresh.addingPercentEncoding(withAllowedCharacters: allowed)!
        request.httpBody = Data("grant_type=refresh_token&refresh_token=\(encoded)".utf8)
        let result = try await transport.send(request)
        try result.requireSuccess()
        guard !loggingOut, generation == credentialGeneration else { throw CredentialError.notLoggedIn }
        struct Reply: Decodable { let id_token: String; let refresh_token: String; let expires_in: String }
        let reply = try JSONDecoder().decode(Reply.self, from: result.data)
        guard !reply.id_token.isEmpty else { throw CredentialError.notLoggedIn }
        try store.write(reply.id_token, for: .idToken)
        try store.write(reply.refresh_token, for: .refreshToken)
        try store.write(Self.format(now().addingTimeInterval(Double(reply.expires_in) ?? 3600)), for: .expiry)
        return reply.id_token
    }

    private func mint(idToken: String) async throws -> String {
        let generation = credentialGeneration
        let api = WorkerAPI(baseURL: apiURL, transport: transport)
        let result = try await api.send(path: "/auth/cli-token", token: idToken, body: .object([:]))
        guard !loggingOut, generation == credentialGeneration else { throw CredentialError.notLoggedIn }
        struct Reply: Decodable { let token: String; let expires_at: Double }
        let reply = try JSONDecoder().decode(Reply.self, from: result.data)
        guard !reply.token.isEmpty else { throw CredentialError.notLoggedIn }
        try store.write(reply.token, for: .cliToken)
        try store.write(Self.format(Date(timeIntervalSince1970: reply.expires_at / 1000)), for: .cliTokenExpiry)
        return reply.token
    }

    public func acceptLogin(idToken: String, refreshToken: String, email: String) async throws {
        guard !loggingOut else { throw CredentialError.notLoggedIn }
        guard !idToken.isEmpty else { throw CredentialError.notLoggedIn }
        // Invalidate any rotation already in flight for the *previous* account:
        // without this, a resolveToken() call started before this login can still
        // resume after it (its own await already in progress) and overwrite the
        // credentials just written below with a refreshed old-account token.
        credentialGeneration &+= 1
        let generation = credentialGeneration
        // A caller that starts token() right after this returns must not await
        // that now-superseded rotation (it will throw once it notices the
        // generation change) — let it start a fresh resolution instead.
        pending = nil
        try store.write(idToken, for: .idToken)
        if !refreshToken.isEmpty { try store.write(refreshToken, for: .refreshToken) }
        try store.write(Self.format(now().addingTimeInterval(3600)), for: .expiry)
        try store.write(email, for: .email)
        _ = try? await mint(idToken: idToken)
        guard !loggingOut, generation == credentialGeneration else { throw CredentialError.notLoggedIn }
    }

    public func logout() async throws {
        guard !loggingOut else { return }
        loggingOut = true
        credentialGeneration &+= 1
        defer { loggingOut = false }
        // Settle any in-flight rotation before deleting, so it cannot resurrect credentials.
        if let pending { _ = try? await pending.task.value }
        // Match auth.Logout in the pinned Go implementation: remove local entries.
        // The CLI documentation describes revocation, but the implementation does not send it.
        for key in CredentialKey.allCases { try store.delete(key) }
    }

    private func expiry(_ key: CredentialKey) throws -> Date? {
        guard let value = try store.read(key) else { return nil }
        let parser = ISO8601DateFormatter()
        if let date = parser.date(from: value) { return date }
        parser.formatOptions.insert(.withFractionalSeconds)
        return parser.date(from: value)
    }
    private static func format(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}

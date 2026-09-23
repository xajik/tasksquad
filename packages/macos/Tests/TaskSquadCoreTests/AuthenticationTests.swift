import XCTest
@testable import TaskSquadCore

private final class MemoryCredentials: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [CredentialKey: String]
    init(_ values: [CredentialKey: String] = [:]) { self.values = values }
    func read(_ key: CredentialKey) throws -> String? { lock.withLock { values[key] } }
    func write(_ value: String, for key: CredentialKey) throws { lock.withLock { values[key] = value } }
    func delete(_ key: CredentialKey) throws { lock.withLock { values[key] = nil } }
}

private actor ScriptedTransport: HTTPTransport {
    var requests: [URLRequest] = []
    private var responses: [HTTPResult]
    init(_ responses: [HTTPResult] = []) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        return responses.removeFirst()
    }
}

private actor SuspendedMint: HTTPTransport {
    private var continuation: CheckedContinuation<HTTPResult, Never>?
    let started: @Sendable () -> Void
    init(started: @escaping @Sendable () -> Void) { self.started = started }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        await withCheckedContinuation { continuation in self.continuation = continuation; started() }
    }
    func release() {
        continuation?.resume(returning: .init(data: Data(#"{"token":"late-token","expires_at":1900000000000}"#.utf8), status: 200))
        continuation = nil
    }
}

@MainActor final class AuthenticationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func date(_ offset: TimeInterval) -> String { ISO8601DateFormatter().string(from: now.addingTimeInterval(offset)) }
    private func auth(_ store: MemoryCredentials, _ transport: ScriptedTransport) -> Authentication {
        let now = now
        return Authentication(store: store, transport: transport, apiURL: "https://worker.example/api", firebaseAPIKey: "public-key", now: { now })
    }

    func testValidCLIRequiresNoNetwork() async throws {
        let store = MemoryCredentials([.cliToken: "tsq_cli_valid", .cliTokenExpiry: date(8 * 86400)])
        let transport = ScriptedTransport()
        let token = try await auth(store, transport).token()
        XCTAssertEqual(token, "tsq_cli_valid")
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testNearExpirySurvivesFailedRotation() async throws {
        let store = MemoryCredentials([.cliToken: "tsq_cli_valid", .cliTokenExpiry: date(86400)])
        let token = try await auth(store, ScriptedTransport()).token()
        XCTAssertEqual(token, "tsq_cli_valid")
    }

    func testExpiredCLIRefreshesFirebaseAndMintsWithCorrectWireFormat() async throws {
        let store = MemoryCredentials([.cliToken: "expired", .cliTokenExpiry: date(-1), .refreshToken: "r+&=é"])
        let transport = ScriptedTransport([
            .init(data: Data(#"{"id_token":"fresh-id","refresh_token":"fresh-refresh","expires_in":"3600"}"#.utf8), status: 200),
            .init(data: Data(#"{"token":"tsq_cli_new","expires_at":1900000000000}"#.utf8), status: 200),
        ])
        let token = try await auth(store, transport).token()
        XCTAssertEqual(token, "tsq_cli_new")
        XCTAssertEqual(try store.read(.refreshToken), "fresh-refresh")
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].url?.host, "securetoken.googleapis.com")
        XCTAssertEqual(String(data: requests[0].httpBody!, encoding: .utf8), "grant_type=refresh_token&refresh_token=r%2B%26%3D%C3%A9")
        XCTAssertEqual(requests[1].url?.absoluteString, "https://worker.example/api/auth/cli-token")
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer fresh-id")
        XCTAssertEqual(String(data: requests[1].httpBody!, encoding: .utf8), "{}")
    }

    func testMintFailureFallsBackToValidFirebase() async throws {
        let store = MemoryCredentials([.idToken: "id", .expiry: date(3600)])
        let transport = ScriptedTransport([.init(data: Data(), status: 503)])
        let token = try await auth(store, transport).token()
        XCTAssertEqual(token, "id")
    }

    func testForceRotationDoesNotReuseCLI() async throws {
        let store = MemoryCredentials([.cliToken: "valid", .cliTokenExpiry: date(30 * 86400), .idToken: "id", .expiry: date(3600)])
        let transport = ScriptedTransport([.init(data: Data(#"{"token":"rotated","expires_at":1900000000000}"#.utf8), status: 200)])
        let token = try await auth(store, transport).token(forceRotation: true)
        XCTAssertEqual(token, "rotated")
    }

    func testConcurrentCallsShareRotation() async throws {
        let store = MemoryCredentials([.idToken: "id", .expiry: date(3600)])
        let transport = ScriptedTransport([.init(data: Data(#"{"token":"shared","expires_at":1900000000000}"#.utf8), status: 200)])
        let authentication = auth(store, transport)
        async let one = authentication.token()
        async let two = authentication.token()
        let tokens = try await [one, two]
        XCTAssertEqual(tokens, ["shared", "shared"])
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 1)
    }

    func testScopedRequestsAndBatchETag() async throws {
        let transport = ScriptedTransport([.init(data: Data(), status: 304, headers: ["ETag": "new-tag"])])
        let api = WorkerAPI(baseURL: "http://127.0.0.1:8787", transport: transport)
        let scoped = try api.request(method: "GET", path: "/daemon/session", token: "token", agentID: "agent")
        XCTAssertEqual(scoped.value(forHTTPHeaderField: "Authorization"), "Bearer token")
        XCTAssertEqual(scoped.value(forHTTPHeaderField: "X-TSQ-Agent"), "agent")
        let result = try await api.batch(entries: [.object(["id": .string("agent"), "status": .string("idle")])], token: "token", etag: "old-tag")
        XCTAssertEqual(result.status, 304)
        XCTAssertEqual(result.headers["etag"], "new-tag")
        let request = await transport.requests[0]
        XCTAssertEqual(request.value(forHTTPHeaderField: "If-None-Match"), "old-tag")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-TSQ-Agent"))
        let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)
        XCTAssertEqual(body["agents"]?.array?.first?["id"]?.string, "agent")
    }

    func testLogoutMatchesGoLocalCredentialRemoval() async throws {
        let store = MemoryCredentials(Dictionary(uniqueKeysWithValues: CredentialKey.allCases.map { ($0, "test-value") }))
        let transport = ScriptedTransport()
        try await auth(store, transport).logout()
        for key in CredentialKey.allCases { XCTAssertNil(try store.read(key)) }
        let requests = await transport.requests
        XCTAssertTrue(requests.isEmpty)
    }

    func testPendingLoginCannotRestoreCredentialsAfterLogout() async throws {
        let started = expectation(description: "mint request in flight")
        let store = MemoryCredentials()
        let transport = SuspendedMint { started.fulfill() }
        let authentication = Authentication(store: store, transport: transport, apiURL: "https://worker.invalid", firebaseAPIKey: "")
        let login = Task { try await authentication.acceptLogin(idToken: "id", refreshToken: "refresh", email: "test@example.invalid") }
        await fulfillment(of: [started], timeout: 3)
        try await authentication.logout()
        await transport.release()
        do { try await login.value; XCTFail("Login must be invalidated by logout") } catch { }
        for key in CredentialKey.allCases { XCTAssertNil(try store.read(key)) }
    }
}

import XCTest
@testable import TaskSquad

@MainActor final class MobileAuthTests: XCTestCase {
    func testCredentialsRestoreWithExpiryAndClearOnInvalidation() async throws {
        let service = "ai.tasksquad.auth-test." + UUID().uuidString
        let auth = MobileAuthStore(keychainService: service)
        try auth.acceptToken("test-only-token", expiresAt: Date().addingTimeInterval(60).timeIntervalSince1970*1000)
        let restored = MobileAuthStore(keychainService: service)
        restored.restore(); XCTAssertEqual(restored.token, "test-only-token")
        XCTAssertEqual(try restored.accessToken(forceRefresh: false), "test-only-token")
        restored.invalidate(); XCTAssertNil(restored.token)
        let empty = MobileAuthStore(keychainService: service); empty.restore(); XCTAssertNil(empty.token)
    }
    func testPersistedExpiryAndAccountScopes() async throws {
        let service = "ai.tasksquad.auth-test." + UUID().uuidString
        let auth = MobileAuthStore(keychainService: service)
        try auth.acceptToken("short-lived", expiresAt: Date().addingTimeInterval(0.08).timeIntervalSince1970*1000)
        let other = MobileAuthStore(keychainService: service + ".other"); other.restore(); XCTAssertNil(other.token)
        try await Task.sleep(for: .milliseconds(120))
        let expired = MobileAuthStore(keychainService: service); expired.restore(); XCTAssertNil(expired.token)
    }
    func testExpiredAndRejectedTokensReturnToSignIn() throws {
        let auth = MobileAuthStore(keychainService: "ai.tasksquad.auth-test." + UUID().uuidString)
        XCTAssertThrowsError(try auth.acceptToken("expired", expiresAt: 1))
        XCTAssertNil(auth.token)
        try auth.acceptToken("rejected", expiresAt: Date().addingTimeInterval(60).timeIntervalSince1970*1000)
        XCTAssertThrowsError(try auth.accessToken(forceRefresh: true)); XCTAssertNil(auth.token)
    }
    func testInstalledBundleHasLaunchScreenVersionsAndCallback() throws {
        let bundle = Bundle.main
        XCTAssertNotNil(bundle.object(forInfoDictionaryKey: "UILaunchScreen"))
        XCTAssertNotNil(bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString"))
        XCTAssertNotNil(bundle.object(forInfoDictionaryKey: "CFBundleVersion"))
        let types = try XCTUnwrap(bundle.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String:Any]])
        XCTAssertTrue(types.contains { ($0["CFBundleURLSchemes"] as? [String])?.contains("tasksquad-portal") == true })
        XCTAssertEqual(MobileAuthStore.apiURL.absoluteString,"https://api.tasksquad.ai")
    }
}

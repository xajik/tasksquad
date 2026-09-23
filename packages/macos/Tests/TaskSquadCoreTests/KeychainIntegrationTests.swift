import XCTest
@testable import TaskSquadCore

@MainActor final class KeychainIntegrationTests: XCTestCase {
    func testGoAndSwiftReadEachOthersKeychainUpdates() async throws {
        guard ProcessInfo.processInfo.environment["TSQ_TEST_KEYCHAIN"] == "1",
              let oracle = ProcessInfo.processInfo.environment["TSQ_GO_ORACLE"] else {
            throw XCTSkip("make test-keychain exercises isolated temporary login-Keychain items")
        }
        let service = "tasksquad-native-test-" + UUID().uuidString
        let store = KeychainCredentialStore(service: service)
        defer { try? store.delete(.idToken) }
        let original = "test-only é猫\ntrailing  "
        try store.write(original, for: .idToken)
        actor Collector {
            var data = Data()
            func append(_ data: Data) { self.data.append(data) }
        }
        let collector = Collector()
        let read = try await NativeProcess.run(.init(executable: oracle, arguments: ["keychain-read", service, "id-token"])) { channel, data in
            if case .stdout = channel { await collector.append(data) }
        }
        XCTAssertEqual(read.code, 0)
        let actual = await collector.data
        XCTAssertEqual(actual, Data(original.utf8))
        let updated = "from-go é 猫"
        let write = try await NativeProcess.run(.init(executable: oracle,
            arguments: ["keychain-write", service, "id-token", Data(updated.utf8).base64EncodedString()]))
        XCTAssertEqual(write.code, 0)
        XCTAssertEqual(try store.read(.idToken), updated)
        try store.delete(.idToken)
        XCTAssertNil(try store.read(.idToken))
    }
}

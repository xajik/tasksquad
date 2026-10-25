import XCTest
@testable import TaskSquadCore

final class LocalHookAuthTests: PlatformTestCase {
    func testPrivateCapabilityPersistsAndMatchesGoFormat() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let paths = TaskSquadPaths(home: home)
        let token = try LocalHookAuth.loadOrCreate(port: 7374, paths: paths)
        XCTAssertEqual(token.count, 64)
        XCTAssertEqual(try LocalHookAuth.read(port: 7374, paths: paths), token)
        XCTAssertEqual(try LocalHookAuth.loadOrCreate(port: 7374, paths: paths), token)
        XCTAssertNotEqual(try LocalHookAuth.loadOrCreate(port: 7375, paths: paths), token)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: LocalHookAuth.file(port: 7374, paths: paths).path)
        XCTAssertThrowsError(try LocalHookAuth.read(port: 7374, paths: paths))
    }

    func testRejectsUnauthenticatedBrowserAndRebindingRequests() {
        let token = String(repeating: "a", count: 64)
        func check(_ headers: [String: String], method: String = "POST", target: String = "/hooks/tui-blocked?state=on") -> Int? {
            LocalHookAuth.rejection(.init(method: method, target: target, headers: headers, body: Data()), token: token)
        }
        let native = ["host": "127.0.0.1:7374", "authorization": "Bearer " + token]
        XCTAssertNil(check(native))
        XCTAssertEqual(check(["host": "localhost:7374"]), 401)
        XCTAssertEqual(check(native.merging(["origin": "https://evil.example"]) { _, new in new }), 403)
        XCTAssertEqual(check(native.merging(["origin": ""]) { _, new in new }), 403)
        XCTAssertEqual(check(native.merging(["sec-fetch-site": "same-origin"]) { _, new in new }), 403)
        XCTAssertEqual(check(native.merging(["host": "evil.example:7374"]) { _, new in new }), 403)
        XCTAssertEqual(check(native, method: "GET"), 405)
        XCTAssertEqual(check(native, method: "OPTIONS"), 405)
        XCTAssertNil(check(["host": "localhost:7374"], target: "/hooks/event?hook_token=" + token))
        XCTAssertEqual(check(["host": "localhost:7374"], target: "/hooks/skill?hook_token=" + token), 401)
    }
}

import XCTest
@testable import TaskSquadCore

/// Go autostart/power behaviour; Fixtures/launchagent-golden.plist is Go's autostart.Enable output (HOME=/tmp/tsq-plist-home).
final class AppLifecycleTests: XCTestCase {
    func testLaunchAgentPlistMatchesGoByteForByte() throws {
        let fixture = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil)?.appendingPathComponent("launchagent-golden.plist"))
        let agent = LaunchAgent(home: URL(fileURLWithPath: "/tmp/tsq-plist-home"))
        XCTAssertEqual(agent.plist(executable: #"/Applications/Task Squad & Co/<tsq>"'.app/Contents/MacOS/tsq"#), try String(contentsOf: fixture, encoding: .utf8))
    }

    func testEnableDisableAndFirstRun() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-la-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let agent = LaunchAgent(home: home), paths = TaskSquadPaths(home: home)
        XCTAssertFalse(agent.isEnabled)
        XCTAssertTrue(try agent.enableOnFirstRun(executable: "/x/tsq", paths: paths))
        XCTAssertTrue(agent.isEnabled)
        XCTAssertTrue(FileManager.default.fileExists(atPath: paths.config.path + ".autostart-set"))
        try agent.disable()
        XCTAssertFalse(agent.isEnabled)
        try agent.disable() // already gone is fine
        XCTAssertFalse(try agent.enableOnFirstRun(executable: "/x/tsq", paths: paths))
        XCTAssertFalse(agent.isEnabled, "first-run enable happens once; a user's later opt-out sticks")
    }

    func testWakeLockRunsCaffeinateWhileHeld() throws {
        let lock = WakeLock()
        lock.acquire(); lock.acquire()
        XCTAssertTrue(lock.isHeld)
        lock.release()
        XCTAssertFalse(lock.isHeld)
    }
}

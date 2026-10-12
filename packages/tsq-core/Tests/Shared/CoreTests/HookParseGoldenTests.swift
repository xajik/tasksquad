import XCTest
@testable import TaskSquadCore

/// Every provider adapter's ParseStop over sample payloads, dumped from Go (Fixtures/stop-golden.json).
final class HookParseGoldenTests: PlatformTestCase {
    func testParseStopMatchesGoForEveryProvider() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil)?.appendingPathComponent("stop-golden.json"))
        let golden = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let bodies = try XCTUnwrap(golden["bodies"] as? [String])
        let rows = try XCTUnwrap(golden["rows"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 7 * bodies.count * 2)
        for row in rows {
            let provider = row["provider"] as! String, body = bodies[row["body"] as! Int], failure = row["failure"] as! Bool
            let event = HookAdapter.parseStop(provider: provider == "claude-code" ? "" : provider, body: Data(body.utf8), isFailure: failure)
            let label = "\(provider) body#\(row["body"]!) failure=\(failure)"
            XCTAssertEqual(event.reason, row["reason"] as? String, label)
            XCTAssertEqual(event.transcriptPath, row["transcript"] as? String, label)
            XCTAssertEqual(event.hookMessage, row["message"] as? String, label)
            XCTAssertEqual(event.isFailure, row["is_failure"] as? Bool, label)
            XCTAssertEqual(event.sessionID, row["session"] as? String, label)
        }
    }
}

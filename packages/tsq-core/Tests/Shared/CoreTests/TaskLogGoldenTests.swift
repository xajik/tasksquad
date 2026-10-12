import XCTest
@testable import TaskSquadCore

/// Journal lines byte-identical to Go's tasklog (Fixtures/tasklog-golden.jsonl, ts normalized),
/// so either daemon's history readers see the same ~/.tasksquad/tasks/<id>.jsonl.
final class TaskLogGoldenTests: PlatformTestCase {
    func testJournalLinesMatchGoEncodingAndFieldOrder() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-journal-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let artifacts = try RunArtifacts(paths: TaskSquadPaths(home: home), agentName: "Coder", taskID: "t1")
        let tricky = "a<b>&c \"q\" é猫\nline\t\\"
        try await artifacts.event(["type": "task_start", "task_id": "t1", "agent": "Coder", "agent_id": "a1", "session_id": "s1", "subject": tricky, "log_path": "/l/t1.log"])
        try await artifacts.event(["type": "message", "role": "user", "body": tricky])
        try await artifacts.event(["type": "agent_turn", "body": tricky, "transcript_path": ""], omitEmpty: ["transcript_path"])
        try await artifacts.event(["type": "agent_turn", "body": "b", "transcript_path": "/t.jsonl"], omitEmpty: ["transcript_path"])
        try await artifacts.event(["type": "user_reply", "body": tricky])
        try await artifacts.event(["type": "task_end", "status": "closed", "final_text": tricky, "r2_log_key": ""], omitEmpty: ["r2_log_key"])
        try await artifacts.event(["type": "task_end", "status": "crashed", "final_text": "", "r2_log_key": "k/full.log"], omitEmpty: ["r2_log_key"])
        try await artifacts.close()
        let written = try String(contentsOf: artifacts.journalURL, encoding: .utf8)
        let normalized = written.replacingOccurrences(of: #""ts":"[^"]+""#, with: #""ts":"TS""#, options: .regularExpression)
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil)?.appendingPathComponent("tasklog-golden.jsonl"))
        XCTAssertEqual(normalized, try String(contentsOf: url, encoding: .utf8))
        // ts is Go's time.RFC3339 in local time.
        let ts = try XCTUnwrap(written.range(of: #""ts":"([^"]+)""#, options: .regularExpression).map { String(written[$0]).dropFirst(6).dropLast() })
        XCTAssertNotNil(ts.range(of: #"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$"#, options: .regularExpression), String(ts))
    }

    /// Go's time.RFC3339 puts a colon in the offset; Go cannot parse ISO8601FormatStyle's +0800.
    func testTimestampsUseGoRFC3339Offsets() throws {
        let date = Date(timeIntervalSince1970: 1_791_727_800) // 2026-10-11T14:10:00Z
        XCTAssertEqual(GoTime.rfc3339(date, timeZone: try XCTUnwrap(TimeZone(identifier: "Asia/Singapore"))), "2026-10-11T22:10:00+08:00")
        XCTAssertEqual(GoTime.rfc3339(date, timeZone: try XCTUnwrap(TimeZone(identifier: "Asia/Kolkata"))), "2026-10-11T19:40:00+05:30")
        XCTAssertEqual(GoTime.rfc3339(date, timeZone: try XCTUnwrap(TimeZone(identifier: "America/New_York"))), "2026-10-11T10:10:00-04:00")
        XCTAssertEqual(GoTime.rfc3339(date, timeZone: try XCTUnwrap(TimeZone(identifier: "UTC"))), "2026-10-11T14:10:00Z")
    }
}

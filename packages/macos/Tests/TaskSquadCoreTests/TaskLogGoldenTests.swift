import XCTest
@testable import TaskSquadCore

/// Journal lines byte-identical to Go's tasklog (Fixtures/tasklog-golden.jsonl, ts normalized),
/// so either daemon's history readers see the same ~/.tasksquad/tasks/<id>.jsonl.
final class TaskLogGoldenTests: XCTestCase {
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
        XCTAssertNotNil(try? Date(String(ts), strategy: Date.ISO8601FormatStyle(timeZone: .current)))
    }
}

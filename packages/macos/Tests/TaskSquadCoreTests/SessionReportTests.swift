import XCTest
@testable import TaskSquadCore

private struct ReportTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "fixture-token" }
}

/// Worker double: hands one stdout task to the agent and records the session report.
private actor ReportWorker {
    var assigned = false
    var closed = false
    var report: JSONValue?
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        let body = (try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null
        switch request.path {
        case "/daemon/heartbeat/batch":
            var agent: [String: JSONValue] = ["agent_id": .string("report-agent"), "next_poll_ms": .number(50)]
            if !assigned {
                assigned = true
                agent["task"] = .object(["id": .string("report-task"), "subject": .string("s"),
                                         "messages": .array([.object(["role": .string("user"), "body": .string("please run /tsq-end-session-learning")])])])
            }
            return .json(.object(["agents": .array([.object(agent)])]))
        case "/daemon/session/open": return .json(.object(["session_id": .string("01REPORTSESSION")]))
        case "/daemon/session/close": closed = true; return .json(.object(["message_id": .string("m")]))
        case "/daemon/session/metrics": report = body; return .json(.object(["ok": .bool(true)]))
        default: return .json(.object([:]))
        }
    }
}

final class SessionReportTests: XCTestCase {
    func testSkillTokensFromTypedText() {
        XCTAssertEqual(SessionReportParser.skills(in: "/tsq-end-session-learning"), ["tsq-end-session-learning"])
        XCTAssertEqual(SessionReportParser.skills(in: "run $tsq-cleanup then /tsq-kb-builder now"), ["tsq-cleanup", "tsq-kb-builder"])
        XCTAssertEqual(SessionReportParser.skills(in: "path/tsq-x and $5 and /other"), [])
    }

    func testClaudeCountsUsageOncePerMessageAndReadsSkillTool() {
        let lines = [
            #"{"type":"assistant","message":{"id":"m1","model":"claude-opus","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":7},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}"#,
            // The same message streamed again must not double count.
            #"{"type":"assistant","message":{"id":"m1","model":"claude-opus","usage":{"input_tokens":10,"output_tokens":5},"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}]}}"#,
            #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true}]}}"#,
            #"{"type":"assistant","message":{"id":"m2","model":"claude-opus","usage":{"input_tokens":3,"output_tokens":2},"content":[{"type":"tool_use","id":"t2","name":"Skill","input":{"skill":"tsq-end-session-memory"}},{"type":"tool_use","id":"t3","name":"Read","input":{}}]}}"#,
            "not json",
        ].map { Substring($0) }
        var report = SessionReport()
        SessionReportParser.claude(lines, into: &report)
        XCTAssertEqual(report.model, "claude-opus")
        XCTAssertEqual(report.inputTokens, 13); XCTAssertEqual(report.outputTokens, 7)
        XCTAssertEqual(report.cacheReadTokens, 100); XCTAssertEqual(report.cacheWriteTokens, 7)
        XCTAssertEqual(report.tools, ["Bash": 1, "Skill": 1, "Read": 1]); XCTAssertEqual(report.toolCalls, 3)
        XCTAssertEqual(report.toolErrors, 1)
        XCTAssertEqual(report.skills, ["tsq-end-session-memory": 1])
    }

    func testCodexUsesCumulativeTotalsAndCountsToolItems() {
        let lines = [
            #"{"type":"turn_context","payload":{"model":"gpt-6-astra","cwd":"/x"}}"#,
            #"{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}"}}"#,
            #"{"type":"response_item","payload":{"type":"local_shell_call","action":{}}}"#,
            #"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[]}}"#,
            #"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":40,"reasoning_output_tokens":10}}}}"#,
            #"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2000,"cached_input_tokens":1500,"cache_write_input_tokens":3,"output_tokens":90,"reasoning_output_tokens":10}}}}"#,
        ].map { Substring($0) }
        var report = SessionReport()
        SessionReportParser.codex(lines, into: &report)
        XCTAssertEqual(report.model, "gpt-6-astra")
        XCTAssertEqual(report.tools, ["exec_command": 1, "shell": 1])
        XCTAssertEqual(report.inputTokens, 500); XCTAssertEqual(report.cacheReadTokens, 1500)
        XCTAssertEqual(report.cacheWriteTokens, 3); XCTAssertEqual(report.outputTokens, 100)
    }

    func testGenericScanFindsToolCallsAndTokensInNestedJSON() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"""
        {"messages":[{"role":"model","model":"gemini-3","parts":[{"functionCall":{"name":"read_file"}}],
          "usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":9}},
          {"type":"toolCall","name":"bash"},{"content":{"type":"tool_use","name":"edit"}}]}
        """#.utf8))
        var report = SessionReport()
        SessionReportParser.generic(value, into: &report)
        XCTAssertEqual(report.tools, ["read_file": 1, "bash": 1, "edit": 1])
        XCTAssertEqual(report.inputTokens, 50); XCTAssertEqual(report.outputTokens, 9)
        XCTAssertEqual(report.model, "gemini-3")
    }

    func testTranscriptLocationForCodexAndPi() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let codex = home.appendingPathComponent(".codex/sessions/2026/09/30/rollout-2026-09-30T10-00-00-thread-abc.jsonl")
        let pi = home.appendingPathComponent(".pi/agent/sessions/--Users-me-project--/2026-09-30.jsonl")
        for url in [codex, pi] {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("{}".utf8).write(to: url)
        }
        let since = Date().addingTimeInterval(-60)
        XCTAssertEqual(SessionReportParser.transcript(provider: .codex, workDir: "/Users/me/project", hookTranscript: "", codexThread: "thread-abc", since: since, home: home)?.lastPathComponent, codex.lastPathComponent)
        XCTAssertNil(SessionReportParser.transcript(provider: .codex, workDir: "/Users/me/project", hookTranscript: "", codexThread: "other", since: since, home: home))
        XCTAssertEqual(SessionReportParser.transcript(provider: .pi, workDir: "/Users/me/project", hookTranscript: "", codexThread: "", since: since, home: home)?.lastPathComponent, pi.lastPathComponent)
        // Transcripts older than the session are never attributed to it.
        XCTAssertNil(SessionReportParser.transcript(provider: .pi, workDir: "/Users/me/project", hookTranscript: "", codexThread: "", since: Date().addingTimeInterval(60), home: home))
        XCTAssertNil(SessionReportParser.transcript(provider: .opencode, workDir: "/Users/me/project", hookTranscript: "", codexThread: "", since: since, home: home))
    }

    func testEngineReportsSessionMetricsAfterClosingATask() async throws {
        let worker = ReportWorker()
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let config = try DaemonConfiguration.parse("""
        [server]
        url = 'http://127.0.0.1:\(port)'
        [[agents]]
        id = 'report-agent'
        name = 'Report fixture'
        command = '/bin/cat'
        provider = 'stdout'
        work_dir = '\(home.path)'
        """)
        let engine = DaemonEngine(configuration: config, paths: TaskSquadPaths(home: home), tokens: ReportTokens())
        try await engine.start()
        let deadline = ContinuousClock.now.advanced(by: .seconds(15))
        while await worker.report == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
        await engine.stop(); await server.stop()
        let posted = await worker.report
        let report = try XCTUnwrap(posted)
        let closed = await worker.closed
        XCTAssertTrue(closed)
        XCTAssertEqual(report["session_id"]?.string, "01REPORTSESSION")
        XCTAssertEqual(report["provider"]?.string, "stdout")
        XCTAssertEqual(report["turns"]?.number, 1)
        XCTAssertEqual(report["skills"]?["tsq-end-session-learning"]?.number, 1)
        XCTAssertGreaterThanOrEqual(report["duration_ms"]?.number ?? -1, 0)
        XCTAssertNil(report["body"], "reports never carry prompt content")
    }
}

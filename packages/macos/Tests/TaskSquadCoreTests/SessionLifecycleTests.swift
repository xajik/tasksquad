import XCTest
@testable import TaskSquadCore

/// Ported from packages/daemon/metrics/{lifecycle,codex_lifecycle}_test.go.
final class SessionLifecycleTests: XCTestCase {
    private func hook(_ l: SessionLifecycle, _ at: Date, _ json: String) { l.hook(Data(json.utf8), now: at) }
    private func temp() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-life-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func lifecycleNumber(_ report: SessionReport, _ key: String) -> Double? { report.lifecycle?[key]?.number }

    func testClaudeSession() throws {
        let dir = try temp()
        let transcript = dir.appendingPathComponent("sess.jsonl").path
        let subDir = dir.appendingPathComponent("sess/subagents")
        try FileManager.default.createDirectory(at: subDir, withIntermediateDirectories: true)
        try Data(#"{"message":{"id":"m1","model":"claude-haiku-4-5","usage":{"input_tokens":100,"output_tokens":20}}}"#.utf8 + [10])
            .write(to: subDir.appendingPathComponent("agent-a1.jsonl"))
        let t0 = Date(timeIntervalSince1970: 1000)
        func at(_ ms: Int) -> Date { t0.addingTimeInterval(Double(ms) / 1000) }
        let l = SessionLifecycle()
        hook(l, at(0), #"{"hook_event_name":"SessionStart","source":"startup","model":"claude-opus-5-5","transcript_path":"\#(transcript)"}"#)
        hook(l, at(10), #"{"hook_event_name":"UserPromptSubmit","prompt":"secret prompt"}"#)
        hook(l, at(20), #"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t1"}"#)
        hook(l, at(999), #"{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"t1","duration_ms":200}"#)
        hook(l, at(230), #"{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_use_id":"t2"}"#)
        hook(l, at(240), #"{"hook_event_name":"PostToolUseFailure","tool_name":"Edit","tool_use_id":"t2"}"#)
        hook(l, at(250), #"{"hook_event_name":"PermissionDenied","tool_name":"Write","tool_use_id":"t3"}"#)
        hook(l, at(300), #"{"hook_event_name":"SubagentStart","agent_id":"a1","agent_type":"Explore"}"#)
        hook(l, at(310), #"{"hook_event_name":"PreToolUse","agent_id":"a1","tool_name":"Grep","tool_use_id":"t4","transcript_path":"/sub.jsonl"}"#)
        hook(l, at(320), #"{"hook_event_name":"PostToolUse","agent_id":"a1","tool_name":"Grep","tool_use_id":"t4"}"#)
        hook(l, at(800), #"{"hook_event_name":"SubagentStop","agent_id":"a1","agent_type":"Explore"}"#)
        hook(l, at(900), #"{"hook_event_name":"PreCompact","compact_reason":"auto"}"#)
        hook(l, at(1000), #"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"t5"}"#)
        hook(l, at(1010), #"{"hook_event_name":"Stop"}"#)
        hook(l, at(1100), #"{"hook_event_name":"SessionEnd","reason":"other"}"#)
        hook(l, at(1200), "not json")

        var r = SessionReport(); r.provider = "claude-code"
        r.inputTokens = 1000; r.tools = ["Bash": 1]
        l.merge(into: &r, provider: .claudeCode)
        XCTAssertEqual(r.tools, ["Bash": 2, "Grep": 1, "Edit": 1, "Write": 0])
        XCTAssertEqual(r.toolErrors, 1)
        XCTAssertEqual(r.turns, 1); XCTAssertEqual(r.model, "claude-opus-5-5")
        XCTAssertEqual(r.inputTokens, 1100); XCTAssertEqual(r.outputTokens, 20)
        XCTAssertEqual(l.tools["Bash"], .init(calls: 2, totalMs: 200, maxMs: 200, unfinished: 1))
        XCTAssertEqual(l.tools["Write"]?.denied, 1); XCTAssertEqual(l.tools["Grep"]?.subagent, 1)
        XCTAssertEqual(l.subagents["Explore"], .init(runs: 1, totalMs: 500, toolCalls: 1, model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 20))
        XCTAssertEqual(lifecycleNumber(r, "active_ms"), 1000)
        XCTAssertEqual(r.lifecycle?["end_reason"]?.string, "other")
        XCTAssertEqual(l.compactions["auto"], 1)
        XCTAssertEqual(l.transcriptPath, transcript, "a subagent's path must not replace the main transcript")
        XCTAssertEqual(r.json["lifecycle"]?["tools"]?["Bash"]?["subagent_calls"]?.number, 0)
    }

    func testWithoutToolHooksKeepsTranscriptTools() {
        let l = SessionLifecycle()
        hook(l, Date(), #"{"hook_event_name":"SessionStart","source":"resume"}"#)
        var r = SessionReport(); r.tools = ["Read": 4]; r.toolErrors = 2
        l.merge(into: &r, provider: .claudeCode)
        XCTAssertEqual(r.tools, ["Read": 4]); XCTAssertEqual(r.toolErrors, 2)
    }

    func testGeminiHooks() {
        let t0 = Date(timeIntervalSince1970: 2000)
        func at(_ ms: Int) -> Date { t0.addingTimeInterval(Double(ms) / 1000) }
        let l = SessionLifecycle()
        hook(l, at(0), #"{"hook_event_name":"SessionStart","source":"startup","transcript_path":"/g/chat.json"}"#)
        hook(l, at(10), #"{"hook_event_name":"BeforeAgent","prompt":"secret"}"#)
        hook(l, at(20), #"{"hook_event_name":"BeforeModel","llm_request":{"model":"gemini-3-pro","messages":[]}}"#)
        // Two overlapping read_file calls without ids pair oldest-first.
        hook(l, at(100), #"{"hook_event_name":"BeforeTool","tool_name":"read_file","tool_input":{"path":"a"}}"#)
        hook(l, at(150), #"{"hook_event_name":"BeforeTool","tool_name":"read_file","tool_input":{"path":"b"}}"#)
        hook(l, at(300), #"{"hook_event_name":"AfterTool","tool_name":"read_file","tool_response":{"llmContent":"x","error":null}}"#)
        hook(l, at(400), #"{"hook_event_name":"AfterTool","tool_name":"read_file","tool_response":{"llmContent":"","error":"ENOENT"}}"#)
        hook(l, at(500), #"{"hook_event_name":"BeforeTool","tool_name":"run_shell_command"}"#)
        hook(l, at(600), #"{"hook_event_name":"PreCompress","trigger":"auto"}"#)
        hook(l, at(1010), #"{"hook_event_name":"AfterAgent","prompt_response":"secret"}"#)
        hook(l, at(1100), #"{"hook_event_name":"SessionEnd","reason":"exit"}"#)
        var r = SessionReport(); r.provider = "gemini"
        l.merge(into: &r, provider: .gemini)
        XCTAssertEqual(l.tools["read_file"], .init(calls: 2, errors: 1, totalMs: 450, maxMs: 250))
        XCTAssertEqual(l.tools["run_shell_command"]?.unfinished, 1)
        XCTAssertEqual(r.tools["read_file"], 2); XCTAssertEqual(r.toolErrors, 1)
        XCTAssertEqual(r.model, "gemini-3-pro"); XCTAssertEqual(r.turns, 1)
        XCTAssertEqual(l.activeMs, 1000); XCTAssertEqual(l.compactions["auto"], 1)
        XCTAssertEqual(l.endReason, "exit"); XCTAssertEqual(l.events["ModelRequest"], 1)
    }

    func testOpenCodeUsageAndDuplicates() {
        let now = Date(timeIntervalSince1970: 3000)
        let l = SessionLifecycle()
        hook(l, now, #"{"hook_event_name":"SessionStart","source":"startup"}"#)
        // The plugin can be loaded twice; repeated prompts and calls count once.
        for _ in 0..<2 {
            hook(l, now, #"{"hook_event_name":"UserPromptSubmit","message_id":"u1"}"#)
            hook(l, now, #"{"hook_event_name":"PreToolUse","tool_name":"task","tool_use_id":"c1"}"#)
        }
        hook(l, now, #"{"hook_event_name":"SubagentStart","agent_id":"ses_child","agent_type":"general"}"#)
        hook(l, now, #"{"hook_event_name":"PreToolUse","tool_name":"bash","tool_use_id":"c2","agent_id":"ses_child"}"#)
        hook(l, now, #"{"hook_event_name":"PostToolUse","tool_name":"bash","tool_use_id":"c2","agent_id":"ses_child","duration_ms":38}"#)
        hook(l, now, #"{"hook_event_name":"Usage","message_id":"m2","agent_id":"ses_child","model":"opencode/free","input_tokens":100,"output_tokens":5,"cache_read_tokens":50,"cost":0.25}"#)
        hook(l, now, #"{"hook_event_name":"SubagentStop","agent_id":"ses_child"}"#)
        hook(l, now, #"{"hook_event_name":"PostToolUse","tool_name":"task","tool_use_id":"c1","duration_ms":5611}"#)
        hook(l, now, #"{"hook_event_name":"Usage","message_id":"m1","model":"opencode/free","input_tokens":1000,"output_tokens":20,"cost":0.5}"#)
        hook(l, now, #"{"hook_event_name":"Usage","message_id":"m1","model":"opencode/free","input_tokens":1000,"output_tokens":20,"cost":0.5}"#)
        var r = SessionReport(); r.provider = "opencode"
        l.merge(into: &r, provider: .opencode)
        XCTAssertEqual(r.turns, 1); XCTAssertEqual(r.tools["task"], 1); XCTAssertEqual(r.tools["bash"], 1)
        XCTAssertEqual(r.inputTokens, 1100); XCTAssertEqual(r.outputTokens, 25); XCTAssertEqual(r.cacheReadTokens, 50)
        XCTAssertEqual(l.costUSD, 0.75)
        XCTAssertEqual(l.subagents["general"]?.inputTokens, 100); XCTAssertEqual(l.subagents["general"]?.toolCalls, 1)
        XCTAssertEqual(l.subagents["general"]?.model, "opencode/free")
        XCTAssertEqual(l.tools["task"]?.totalMs, 5611); XCTAssertEqual(l.tools["task"]?.unfinished, 0)
    }

    func testUsageNeverOverridesTranscriptTokens() {
        let l = SessionLifecycle()
        hook(l, Date(), #"{"hook_event_name":"Usage","message_id":"m","input_tokens":5}"#)
        var r = SessionReport(); r.inputTokens = 900
        l.merge(into: &r, provider: .claudeCode)
        XCTAssertEqual(r.inputTokens, 900, "transcript totals must win")
    }

    func testTranscriptPicksClawSessionForWorkDir() throws {
        let config = try temp()
        setenv("XDG_CONFIG_HOME", config.path, 1)
        defer { unsetenv("XDG_CONFIG_HOME") }
        let dir = config.appendingPathComponent("agent-code/sessions")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(#"{"cwd":"/work/task","messages":[]}"#.utf8).write(to: dir.appendingPathComponent("mine.json"))
        Thread.sleep(forTimeInterval: 0.02)
        try Data(#"{"cwd":"/work/elsewhere","messages":[]}"#.utf8).write(to: dir.appendingPathComponent("other.json")) // newer, other project
        let found = SessionReportParser.transcript(provider: .claw, workDir: "/work/task/", hookTranscript: "", codexThread: "",
                                                   since: Date().addingTimeInterval(-60), home: config)
        XCTAssertEqual(found?.lastPathComponent, "mine.json")
    }

    private func rollout(_ url: URL, _ lines: [String]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: url)
    }

    func testCodexLifecycleWithSubagent() throws {
        let home = try temp()
        let day = home.appendingPathComponent(".codex/sessions/2026/10/10")
        let main = day.appendingPathComponent("rollout-a-main.jsonl")
        try rollout(main, [
            #"{"timestamp":"2026-10-10T10:00:00.000Z","type":"session_meta","payload":{"id":"main","source":"cli"}}"#,
            #"{"timestamp":"2026-10-10T10:00:00.100Z","type":"event_msg","payload":{"type":"task_started"}}"#,
            #"{"timestamp":"2026-10-10T10:00:00.200Z","type":"turn_context","payload":{"model":"gpt-x"}}"#,
            #"{"timestamp":"2026-10-10T10:00:01.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"c1"}}"#,
            #"{"timestamp":"2026-10-10T10:00:01.300Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1"}}"#,
            #"{"timestamp":"2026-10-10T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"c2"}}"#,
            #"{"timestamp":"2026-10-10T10:00:02.050Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c2"}}"#,
            #"{"timestamp":"2026-10-10T10:00:03.000Z","type":"response_item","payload":{"type":"function_call","name":"apply_patch","call_id":"c3"}}"#,
            #"{"timestamp":"2026-10-10T10:00:04.000Z","type":"compacted","payload":{}}"#,
            #"{"timestamp":"2026-10-10T10:00:05.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50}}}}"#,
            #"{"timestamp":"2026-10-10T10:00:09.000Z","type":"event_msg","payload":{"type":"task_complete","duration_ms":8900}}"#,
            #"{"timestamp":"2026-10-10T10:00:09.500Z","type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}"#,
        ])
        try rollout(day.appendingPathComponent("rollout-b-sub.jsonl"), [
            #"{"timestamp":"2026-10-10T10:00:02.100Z","type":"session_meta","payload":{"id":"sub","parent_thread_id":"main","source":{"subagent":{"thread_spawn":{"parent_thread_id":"main","agent_role":"explorer"}}}}}"#,
            #"{"timestamp":"2026-10-10T10:00:02.200Z","type":"turn_context","payload":{"model":"gpt-mini"}}"#,
            #"{"timestamp":"2026-10-10T10:00:02.300Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","call_id":"s1"}}"#,
            #"{"timestamp":"2026-10-10T10:00:02.400Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"s1"}}"#,
            #"{"timestamp":"2026-10-10T10:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":100,"output_tokens":7}}}}"#,
            #"{"timestamp":"2026-10-10T10:00:03.000Z","type":"event_msg","payload":{"type":"task_complete","duration_ms":900}}"#,
        ])
        try rollout(day.appendingPathComponent("rollout-c-other.jsonl"), [
            #"{"timestamp":"2026-10-10T10:00:02.100Z","type":"session_meta","payload":{"id":"other","parent_thread_id":"someone-else"}}"#,
            #"{"timestamp":"2026-10-10T10:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":99999}}}}"#,
        ])
        let l = try XCTUnwrap(SessionLifecycle.codex(path: main, home: home, since: Date().addingTimeInterval(-3600)))
        var r = SessionReport(); r.provider = "codex"
        SessionReportParser.read(main, provider: .codex, into: &r)
        l.merge(into: &r, provider: .codex)
        XCTAssertEqual(r.tools["exec"], 2); XCTAssertEqual(r.tools["spawn_agent"], 1); XCTAssertEqual(r.tools["apply_patch"], 1)
        XCTAssertEqual(r.inputTokens, 800); XCTAssertEqual(r.outputTokens, 57); XCTAssertEqual(r.cacheReadTokens, 500)
        XCTAssertEqual(l.tools["exec"]?.totalMs, 400); XCTAssertEqual(l.tools["exec"]?.maxMs, 300); XCTAssertEqual(l.tools["exec"]?.subagent, 1)
        XCTAssertEqual(l.tools["apply_patch"]?.unfinished, 1)
        XCTAssertEqual(l.subagents["explorer"], .init(runs: 1, totalMs: 900, toolCalls: 1, model: "gpt-mini", inputTokens: 200, outputTokens: 7, cacheReadTokens: 100))
        XCTAssertEqual(l.activeMs, 8900); XCTAssertEqual(l.prompts, 1)
        XCTAssertEqual(l.compactions["auto"], 1); XCTAssertEqual(l.stopFailures["interrupted"], 1)
        XCTAssertEqual(r.lifecycle?["source"]?.string, "transcript")
    }

    func testCodexLifecycleMissingRollout() throws {
        XCTAssertNil(SessionLifecycle.codex(path: try temp().appendingPathComponent("nope.jsonl"), home: try temp(), since: Date()))
    }
}

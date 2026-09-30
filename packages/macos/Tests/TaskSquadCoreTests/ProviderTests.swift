import XCTest
@testable import TaskSquadCore

final class ProviderTests: XCTestCase {
    func testDetectionMatchesGoRegistryAndDefaultsToClaude() {
        let cases: [(String, String, ProviderKind)] = [
            ("claude --dangerously-skip-permissions", "", .claudeCode),
            ("gemini --yolo", "", .gemini),
            ("opencode -m opencode/minimax-m2.5-free", "", .opencode),
            ("agent --dangerously-skip-permissions", "", .claw),
            ("pi", "", .pi),
            ("codex --yolo", "", .codex),
            ("/opt/homebrew/bin/Codex", "", .codex),
            ("my-tool --flag", "", .claudeCode),
            ("my-tool", "STDOUT", .stdout),
            ("claude", "claude-code", .claudeCode),
            ("claude", "unknown-override", .claudeCode),
        ]
        for (command, override, expected) in cases {
            XCTAssertEqual(ProviderKind.detect(command: command, override: override), expected, command)
        }
        XCTAssertTrue(ProviderKind.claudeCode.interactive)
        XCTAssertFalse(ProviderKind.pi.interactive)
        XCTAssertTrue(ProviderKind.pi.usesHooks)
        XCTAssertFalse(ProviderKind.stdout.usesHooks)
    }

    func testClaudeSettingsArePerInvocation() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let arguments = try ProviderKind.claudeCode.setupArguments(hooksPort: 7374, agentID: "A1", taskID: "T1", temporaryDirectory: folder)
        XCTAssertEqual(arguments, ["--settings", folder.appendingPathComponent("tsq-settings-A1-T1.json").path])
        let settings = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: arguments[1]))) as? [String: Any]
        let hooks = try XCTUnwrap(settings?["hooks"] as? [String: [[String: Any]]])
        func url(_ event: String) -> String? { (hooks[event]?.first?["hooks"] as? [[String: Any]])?.first?["url"] as? String }
        XCTAssertEqual(url("Stop"), "http://localhost:7374/hooks/stop?agent=A1&task_id=T1")
        XCTAssertEqual(url("StopFailure"), "http://localhost:7374/hooks/stop?agent=A1&task_id=T1&failure=true")
        XCTAssertEqual(url("PreToolUse"), "http://localhost:7374/hooks/tui-blocked?agent=A1&task_id=T1&state=on")
        XCTAssertEqual(hooks["PostToolUse"]?.first?["matcher"] as? String, "AskUserQuestion")
    }

    func testCodexNotifyAndPromptFormatting() throws {
        let arguments = try ProviderKind.codex.setupArguments(hooksPort: 9000, agentID: "A1", taskID: "T 1")
        XCTAssertEqual(arguments.first, "-c")
        let argv = try JSONSerialization.jsonObject(with: Data(arguments[1].dropFirst("notify=".count).utf8)) as? [String]
        XCTAssertEqual(argv?.prefix(2), ["sh", "-c"])
        XCTAssertEqual(argv?.last, "http://127.0.0.1:9000/hooks/codex?agent=A1&task_id=T%201")
        XCTAssertFalse(arguments[1].contains("\\/"), "TOML has no \\/ escape")
        XCTAssertEqual(ProviderKind.codex.formatPrompt("run /tsq-attach-image now, not a/tsq-x"), "run $tsq-attach-image now, not a/tsq-x")
        XCTAssertEqual(ProviderKind.claudeCode.formatPrompt("/tsq-x"), "/tsq-x")
        XCTAssertEqual(ProviderKind.codex.initialPromptArguments("hi"), ["--", "hi"])
        XCTAssertEqual(ProviderKind.codex.extraArguments, ["--no-alt-screen"])
    }

    func testWorkDirHookFilesMergeWithExistingSettings() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let gemini = root.appendingPathComponent(".gemini/settings.json")
        try FileManager.default.createDirectory(at: gemini.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"theme":"dark","hooks":{"Old":[]}}"#.utf8).write(to: gemini)
        for kind in ProviderKind.allCases { try kind.setup(workDir: root.path, hooksPort: 7374, agentID: "A1", taskID: "T1") }
        let merged = try JSONSerialization.jsonObject(with: Data(contentsOf: gemini)) as? [String: Any]
        XCTAssertEqual(merged?["theme"] as? String, "dark")
        let hooks = merged?["hooks"] as? [String: Any]
        XCTAssertNil(hooks?["Old"])
        let command = ((hooks?["AfterAgent"] as? [[String: Any]])?.first?["hooks"] as? [[String: Any]])?.first?["command"] as? String
        XCTAssertEqual(command, #"curl -sS -X POST "http://localhost:7374/hooks/stop?agent=A1&task_id=T1&provider=gemini" -H "Content-Type: application/json" -d @- > /dev/null 2>&1; printf '{}'"#)
        let plugin = try String(contentsOf: root.appendingPathComponent(".opencode/plugins/tasksquad.ts"), encoding: .utf8)
        XCTAssertTrue(plugin.contains(#"fetch("http://localhost:7374" + path"#))
        XCTAssertTrue(plugin.contains(#"post("/hooks/stop?agent=A1&task_id=T1&provider=opencode", { stop_reason: "idle", message })"#))
        let pi = try String(contentsOf: root.appendingPathComponent(".pi/extensions/tasksquad.ts"), encoding: .utf8)
        XCTAssertTrue(pi.contains(#""/hooks/stop?agent=A1&task_id=T1&provider=pi","#))
        let claw = try String(contentsOf: root.appendingPathComponent(".agent/settings.json"), encoding: .utf8)
        XCTAssertTrue(claw.contains("/hooks/stop?agent=A1&task_id=T1&failure=true"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(".claude").path))
    }

    func testHookPayloadsAndTranscripts() throws {
        let claude = HookAdapter.parseStop(provider: "", body: Data(#"{"stop_reason":"end_turn","session_id":"s1","last_assistant_message":"done","transcript_path":"/t"}"#.utf8), isFailure: false)
        XCTAssertEqual(claude, HookStopEvent(reason: "end_turn", transcriptPath: "/t", hookMessage: "done", isFailure: false, sessionID: "s1"))
        XCTAssertTrue(HookAdapter.parseStop(provider: "", body: Data(#"{"error_type":"rate_limit"}"#.utf8), isFailure: true).isFailure)
        let codex = HookAdapter.parseStop(provider: "codex", body: Data(#"{"thread-id":"th","last-assistant-message":"hi"}"#.utf8), isFailure: false)
        XCTAssertEqual(codex.sessionID, "th"); XCTAssertEqual(codex.hookMessage, "hi")
        XCTAssertTrue(HookAdapter.parseStop(provider: "opencode", body: Data(#"{"stop_reason":"error","message":"boom"}"#.utf8), isFailure: false).isFailure)

        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let jsonl = folder.appendingPathComponent("claude.jsonl")
        try Data("""
        {"type":"user","message":{"role":"user","content":[{"type":"text","text":"q"}]}}
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"first"}]}}
        not json
        {"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use"},{"type":"text","text":"last é猫"},{"type":"text","text":"line"}]}}

        """.utf8).write(to: jsonl)
        XCTAssertEqual(HookAdapter.extractTranscript(provider: .claudeCode, path: jsonl.path), "last é猫\nline")
        let gemini = folder.appendingPathComponent("gemini.json")
        try Data(#"{"messages":[{"type":"gemini","content":"old"},{"type":"gemini","content":[{"text":"a"},{"text":"b"}]},{"type":"user","content":"x"}]}"#.utf8).write(to: gemini)
        XCTAssertEqual(HookAdapter.extractTranscript(provider: .gemini, path: gemini.path), "a\nb")
        let pi = folder.appendingPathComponent("pi.jsonl")
        try Data("""
        {"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"pi answer"}]}}
        {"type":"message","message":{"role":"user","content":"later"}}
        """.utf8).write(to: pi)
        XCTAssertEqual(HookAdapter.extractTranscript(provider: .pi, path: pi.path), "pi answer")
        XCTAssertEqual(HookAdapter.extractTranscript(provider: .codex, path: pi.path), "")
    }
}

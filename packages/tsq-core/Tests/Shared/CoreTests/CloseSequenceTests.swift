import XCTest
@testable import TaskSquadCore

private struct SequenceTokens: TokenProvider { func token(forceRotation: Bool) async throws -> String { "t" } }

/// Hands out a task, then (once the turn is paused) a two-step close sequence; while
/// the sequence runs it also sends a user `close`, which Go ignores in wrapping_up.
private actor SequenceWorker {
    var assigned = false, stepsSent = false, closeDuringSequence = false
    var stepIndexes: [Double] = []
    var close: JSONValue?
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        let body = (try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null
        switch request.path {
        case "/daemon/heartbeat/batch":
            let entry = body["agents"]?.array?.first
            let status = entry?["status"]?.string ?? ""
            var agent: [String: JSONValue] = ["agent_id": .string("a"), "next_poll_ms": .number(50)]
            if !assigned { assigned = true; agent["task"] = .object(["id": .string("t1"), "subject": .string("s"), "messages": .array([])]) }
            else if status == "waiting_input", !stepsSent { stepsSent = true; agent["close_steps"] = .array([.string("/tsq-end-session-learning"), .string(""), .string("/tsq-end-session-memory")]) }
            else if status == "wrapping_up" {
                if let idx = entry?["close_step_idx"]?.number { stepIndexes.append(idx) }
                if !closeDuringSequence { closeDuringSequence = true; agent["close"] = .bool(true) }
            }
            return .json(.object(["agents": .array([.object(agent)])]))
        case "/daemon/session/open": return .json(.object(["session_id": .string("01SEQSESSION")]))
        case "/daemon/session/notify": return .json(.object(["message_id": .string("m"), "close": .bool(false)]))
        case "/daemon/session/close": close = body; return .json(.object([:]))
        default: return .json(.object([:]))
        }
    }
}

/// Go agent/closesequence behaviour end to end: empty steps dropped, each Stop advances one
/// step in order, heartbeats report close_step_idx, a user close mid-sequence is ignored, and
/// the task closes "closed" after the last step.
final class CloseSequenceTests: PlatformTestCase {
    func testCloseStepsRunInOrderAndCompleteClosed() async throws {
        guard let tmuxPath = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux")
        else { throw XCTSkip("tmux required") }
        let tmux = TmuxConnection(executable: tmuxPath, socketPath: "/tmp/tsq-seq-" + UUID().uuidString.prefix(8) + ".sock")
        defer { Task { _ = try? await tmux.run(["kill-server"]) } }
        let worker = SequenceWorker()
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-seq-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let bin = home.appendingPathComponent("bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let claude = bin.appendingPathComponent("claude")
        try Data("""
        #!/bin/sh
        settings=""
        while [ $# -gt 0 ]; do [ "$1" = "--settings" ] && settings="$2"; shift; done
        url=$(grep -o 'http://localhost:[0-9]*/hooks/stop?agent=[^"]*' "$settings" | grep -v failure | head -1 | sed -e 's/localhost/127.0.0.1/' -e 's/\\\\u0026/\\&/g')
        while IFS= read -r line; do printf '%s\\n' "$line" >> typed.log; curl -s -H "Authorization: Bearer $TSQ_HOOK_TOKEN" -X POST "$url" --data-binary '{"session_id":"","stop_reason":"end_turn","last_assistant_message":"ok"}' >/dev/null; done
        """.utf8).write(to: claude)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: claude.path)
        let hooks = try await freeLoopbackPort()
        let config = try DaemonConfiguration.parse("""
        [server]
        url = 'http://127.0.0.1:\(port)'
        [hooks]
        port = \(hooks)
        [[agents]]
        id = 'a'
        name = 'seq'
        command = '\(claude.path)'
        work_dir = '\(home.path)'
        """)
        var timing = InteractiveTiming()
        timing.readyWait = .milliseconds(300); timing.submitWait = .milliseconds(100); timing.replyDelay = .milliseconds(100)
        let engine = DaemonEngine(configuration: config, paths: TaskSquadPaths(home: home), tokens: SequenceTokens(), tmux: tmux, timing: timing)
        try await engine.start()
        let deadline = ContinuousClock.now.advanced(by: .seconds(20))
        while await worker.close == nil, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
        let close = await worker.close
        XCTAssertEqual(close?["status"]?.string, "closed", "the user close mid-sequence was ignored; the steps finished")
        let typed = try String(contentsOf: home.appendingPathComponent("typed.log"), encoding: .utf8).split(separator: "\n").map(String.init)
        XCTAssertEqual(Array(typed.dropFirst()), ["/tsq-end-session-learning", "/tsq-end-session-memory"], "prompt, then each non-empty step once, in order")
        let indexes = await worker.stepIndexes
        XCTAssertTrue(indexes.contains(0), "\(indexes)")
        XCTAssertEqual(indexes.sorted(), indexes, "close_step_idx only advances")
        await engine.stop()
        await server.stop()
    }
}

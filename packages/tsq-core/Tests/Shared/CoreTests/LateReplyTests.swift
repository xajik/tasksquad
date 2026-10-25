import XCTest
@testable import TaskSquadCore

private struct LateTokens: TokenProvider { func token(forceRotation: Bool) async throws -> String { "t" } }

/// Holds the first notify open while the server closes task A and hands out task B.
private actor RaceWorker {
    var opened = 0, heartbeats = 0
    var notifyWaiting = false
    var released = false
    private var pending: CheckedContinuation<Void, Never>?
    var closeSent = false, secondTaskSent = false
    var autoClose = false
    func setAutoClose(_ value: Bool) { autoClose = value }
    func release() { released = true; pending?.resume(); pending = nil }

    func handle(_ request: LocalHTTPRequest) async -> LocalHTTPResponse {
        let body = (try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null
        switch request.path {
        case "/daemon/heartbeat/batch":
            heartbeats += 1
            let status = body["agents"]?.array?.first?["status"]?.string ?? ""
            var agent: [String: JSONValue] = ["agent_id": .string("a"), "next_poll_ms": .number(50)]
            if opened == 0 { agent["task"] = .object(["id": .string("task-a"), "subject": .string("s"), "messages": .array([])]) }
            else if notifyWaiting, !closeSent { closeSent = true; agent["close"] = .bool(true) }
            else if closeSent, !secondTaskSent, status == "idle" {
                secondTaskSent = true
                agent["task"] = .object(["id": .string("task-b"), "subject": .string("s"), "messages": .array([])])
            }
            return .json(.object(["agents": .array([.object(agent)])]))
        case "/daemon/session/open":
            opened += 1
            return .json(.object(["session_id": .string(opened == 1 ? "01SESSIONAAAA" : "01SESSIONBBBB")]))
        case "/daemon/session/notify":
            if !released {
                notifyWaiting = true
                await withCheckedContinuation { pending = $0 }
            }
            return .json(.object(["message_id": .string("m"), "close": .bool(autoClose)]))
        default:
            return .json(.object([:]))
        }
    }
}

/// Go agent/terminal_control_test TestLatePausedReplyCannotChangeReplacementSession.
final class LateReplyTests: PlatformTestCase {
    func testLatePausedReplyCannotChangeReplacementSession() async throws {
        guard let tmuxPath = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux")
        else { throw XCTSkip("tmux required") }
        for autoClose in [false, true] {
            let tmux = TmuxConnection(executable: tmuxPath, socketPath: "/tmp/tsq-late-" + UUID().uuidString.prefix(8) + ".sock")
            let worker = RaceWorker()
            await worker.setAutoClose(autoClose)
            let server = try LocalHTTPServer { await worker.handle($0) }
            let port = try await server.start()
            let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-late-" + UUID().uuidString)
            let bin = home.appendingPathComponent("bin")
            try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
            // Claude-like: reports a Stop for every typed line.
            let claude = bin.appendingPathComponent("claude")
            try Data("""
            #!/bin/sh
            settings=""
            while [ $# -gt 0 ]; do [ "$1" = "--settings" ] && settings="$2"; shift; done
            url=$(grep -o 'http://localhost:[0-9]*/hooks/stop?agent=[^"]*' "$settings" | grep -v failure | head -1 | sed -e 's/localhost/127.0.0.1/' -e 's/\\\\u0026/\\&/g')
            # Only task A reports turns; task B keeps running so any change to it comes from A's late reply.
            [ "$TSQ_TASK_ID" = "task-a" ] || exec sleep 60
            while IFS= read -r line; do curl -s -H "Authorization: Bearer $TSQ_HOOK_TOKEN" -X POST "$url" --data-binary '{"session_id":"","stop_reason":"end_turn","last_assistant_message":"OLD REPLY"}' >/dev/null; done
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
            name = 'late'
            command = '\(claude.path)'
            work_dir = '\(home.path)'
            """)
            var timing = InteractiveTiming()
            timing.readyWait = .milliseconds(300); timing.submitWait = .milliseconds(100); timing.replyDelay = .milliseconds(100)
            let engine = DaemonEngine(configuration: config, paths: TaskSquadPaths(home: home), tokens: LateTokens(), tmux: tmux, timing: timing)
            try await engine.start()
            func wait(_ condition: () async -> Bool) async throws {
                let deadline = ContinuousClock.now.advanced(by: .seconds(15))
                while !(await condition()) {
                    guard ContinuousClock.now < deadline else { XCTFail("timed out (autoClose=\(autoClose))"); return }
                    try await Task.sleep(for: .milliseconds(50))
                }
            }
            try await wait { await worker.notifyWaiting }
            try await wait { let first = await engine.snapshots().first; return first?.taskID == "task-b" && first?.mode == .running }
            try await wait { ((try? await tmux.run(["list-sessions", "-F", "#{session_name}"])) ?? "").contains("tsq-01SESSIONBBBB") }
            await worker.release()
            try await Task.sleep(for: .milliseconds(800))
            let snapshot = await engine.snapshots().first
            XCTAssertEqual(snapshot?.taskID, "task-b", "autoClose=\(autoClose)")
            XCTAssertEqual(snapshot?.sessionID, "01SESSIONBBBB", "autoClose=\(autoClose)")
            XCTAssertEqual(snapshot?.mode, .running, "a late reply for task A must not pause or close task B (autoClose=\(autoClose))")
            let sessions = (try? await tmux.run(["list-sessions", "-F", "#{session_name}"])) ?? ""
            XCTAssertTrue(sessions.contains("tsq-01SESSIONBBBB"), "replacement session survives (autoClose=\(autoClose))")
            await engine.stop()
            await server.stop()
            _ = try? await tmux.run(["kill-server"])
            try? FileManager.default.removeItem(at: home)
        }
    }
}

import XCTest
@testable import TaskSquadCore

private struct FixtureTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "fixture-token" }
}

/// Worker double for a paused, multi-turn interactive session.
private actor InteractiveWorker {
    var assigned = false
    var replied = false
    var notifies: [String] = []
    var close: JSONValue?
    var statuses: [String] = []
    var uploads = 0
    var base = ""
    func setBase(_ value: String) { base = value }
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        let body = (try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null
        switch request.path {
        case "/daemon/heartbeat/batch":
            let status = body["agents"]?.array?.first?["status"]?.string ?? ""
            statuses.append(status)
            var agent: [String: JSONValue] = ["agent_id": .string("fixture-agent"), "next_poll_ms": .number(50)]
            if !assigned {
                assigned = true
                let message = JSONValue.object(["role": .string("user"), "body": .string("first é猫")])
                agent["task"] = .object(["id": .string("fixture-task"), "subject": .string("s"), "messages": .array([message])])
            } else if status == "waiting_input" && !replied {
                replied = true
                agent["reply"] = .string("second turn")
            }
            return .json(.object(["agents": .array([.object(agent)])]))
        case "/daemon/session/open":
            return .json(.object(["session_id": .string("01FIXTURESESSION")]))
        case "/daemon/session/notify":
            notifies.append(body["message"]?.string ?? "")
            // The second paused reply is auto-closed by the server.
            return .json(.object(["message_id": .string("m\(notifies.count)"), "close": .bool(notifies.count == 2)]))
        case "/daemon/session/close":
            close = body
            return .json(.object(["message_id": .string("final")]))
        case "/daemon/r2/presign":
            return .json(.object(["upload_url": .string(base + "/upload"), "key": .string("k")]))
        case "/upload":
            uploads += 1
            return .init()
        default:
            return .json(.object([:]))
        }
    }
}

@MainActor final class InteractiveEngineTests: XCTestCase {
    private func tmuxConnection() throws -> TmuxConnection {
        guard let executable = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux")
        else { throw XCTSkip("tmux is required for interactive provider tests") }
        return TmuxConnection(executable: executable, socketPath: "/tmp/tsq-engine-test-" + UUID().uuidString.prefix(8) + ".sock")
    }

    private func freePort() async throws -> Int {
        let probe = try LocalHTTPServer { _ in .init() }
        let port = try await probe.start()
        await probe.stop()
        return Int(port)
    }

    private func wait(_ timeout: Duration = .seconds(15), until condition: () async -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { XCTFail("Timed out waiting for condition"); return }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    private func makeEngine(script: String, binary: String = "claude", worker: InteractiveWorker, tmux: TmuxConnection,
                            errors: @escaping @Sendable (String) -> Void) async throws -> (DaemonEngine, LocalHTTPServer, URL) {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let bin = home.appendingPathComponent("bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        // Named `claude` so provider detection chooses Claude Code with no override.
        let executable = bin.appendingPathComponent(binary)
        try Data(script.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        await worker.setBase("http://127.0.0.1:\(port)")
        let hooksPort = try await freePort()
        let config = try DaemonConfiguration.parse("""
        [server]
        url = 'http://127.0.0.1:\(port)'
        [hooks]
        port = \(hooksPort)
        [[agents]]
        id = 'fixture-agent'
        name = 'Claude fixture'
        command = '\(executable.path)\(binary == "claude" ? " --dangerously-skip-permissions" : "")'
        work_dir = '\(home.path)'
        """)
        var timing = InteractiveTiming()
        timing.readyWait = .milliseconds(300); timing.submitWait = .milliseconds(100); timing.replyDelay = .milliseconds(100)
        let engine = DaemonEngine(configuration: config, paths: TaskSquadPaths(home: home), tokens: FixtureTokens(),
                                  tmux: tmux, timing: timing, onError: errors)
        return (engine, server, home)
    }

    func testClaudeRunsInTmuxPausesOnStopHookTakesReplyAndAutoCloses() async throws {
        let tmux = try tmuxConnection()
        defer { Task { _ = try? await tmux.run(["kill-server"]) } }
        // Reads each typed prompt, then reports the turn through the Stop hook URL
        // from the per-invocation --settings file, exactly as Claude Code would.
        let script = """
        #!/bin/sh
        settings=""
        while [ $# -gt 0 ]; do [ "$1" = "--settings" ] && settings="$2"; shift; done
        url=$(grep -o 'http://localhost:[0-9]*/hooks/stop?agent=[^"]*' "$settings" | grep -v failure | head -1 | sed 's/localhost/127.0.0.1/')
        [ -n "$url" ] || exit 9
        printf 'READY %s\\n' "$TSQ_TASK_ID"
        n=0
        while IFS= read -r line; do
          n=$((n+1))
          printf 'got:%s\\n' "$line"
          curl -s -X POST "$url" -H 'Content-Type: application/json' --data-binary "{\\"session_id\\":\\"cli-1\\",\\"stop_reason\\":\\"end_turn\\",\\"last_assistant_message\\":\\"turn$n:$line\\"}" >/dev/null
        done
        """
        let worker = InteractiveWorker()
        let (engine, server, home) = try await makeEngine(script: script, worker: worker, tmux: tmux, errors: { XCTFail($0) })
        defer { try? FileManager.default.removeItem(at: home) }
        try await engine.start()
        try await wait { await worker.notifies.count >= 1 }
        try await wait { await worker.notifies.count >= 2 }
        try await wait { await engine.snapshots().first?.mode == .idle }
        try await wait { (try? await tmux.panes().isEmpty) ?? true }
        let notifies = await worker.notifies
        XCTAssertEqual(notifies, ["turn1:first é猫", "turn2:second turn"])
        let close = await worker.close
        XCTAssertNil(close, "an auto-closed session must not post a second close")
        try await wait { await worker.uploads >= 2 }
        let statuses = await worker.statuses
        XCTAssertTrue(statuses.contains("waiting_input"))
        let taskID = await engine.snapshots().first?.taskID
        XCTAssertEqual(taskID, "")
        let journal = try String(contentsOf: home.appendingPathComponent(".tasksquad/tasks/fixture-task.jsonl"), encoding: .utf8)
        XCTAssertTrue(journal.contains("\"agent_turn\""))
        XCTAssertTrue(journal.contains("\"user_reply\""))
        let log = try String(contentsOf: home.appendingPathComponent(".tasksquad/logs/Claude-fixture/fixture-task.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("[EVENT] event=running via=tmux session=tsq-01FIXTURESESSION"), log)
        XCTAssertTrue(log.contains("READY fixture-task"), log)
        XCTAssertTrue(log.contains("got:first é猫"), log)
        XCTAssertFalse(FileManager.default.fileExists(atPath: "/tmp/tsq-01FIXTURESESSION.fifo"))
        await engine.stop()
        await server.stop()
    }

    func testSessionEndingWithoutHookIsReportedAsCrash() async throws {
        let tmux = try tmuxConnection()
        defer { Task { _ = try? await tmux.run(["kill-server"]) } }
        let worker = InteractiveWorker()
        let (engine, server, home) = try await makeEngine(script: "#!/bin/sh\nprintf 'starting\\n'\nsleep 1\nprintf 'bye\\n'\nexit 3\n",
                                                          worker: worker, tmux: tmux, errors: { XCTFail($0) })
        defer { try? FileManager.default.removeItem(at: home) }
        try await engine.start()
        try await wait { await worker.close != nil }
        let close = await worker.close
        XCTAssertEqual(close?["status"], .string("crashed"))
        XCTAssertEqual(close?["final_text"]?.string?.contains("bye"), true)
        try await wait { await engine.snapshots().first?.mode == .idle }
        await engine.stop()
        await server.stop()
    }

    func testPiHookDoesNotMaskFailedExitAndStderrBecomesTheMessage() async throws {
        let tmux = try tmuxConnection()
        // Real Pi fires agent_end (-> stop hook, empty message) even when the model
        // call fails, then prints the error to stderr and exits non-zero.
        let script = """
        #!/bin/sh
        [ "$1" = "-p" ] || exit 23
        ext=.pi/extensions/tasksquad.ts
        port=$(grep -o 'http://localhost:[0-9]*' "$ext" | head -1 | sed 's/.*://')
        path=$(grep -o '/hooks/stop?agent=[^"]*' "$ext" | head -1)
        curl -s -X POST "http://127.0.0.1:$port$path" -H 'Content-Type: application/json' --data-binary '{"stop_reason":"idle","message":""}' >/dev/null
        echo 'Error: model omlx/default is not loaded' >&2
        exit 1
        """
        let worker = InteractiveWorker()
        let (engine, server, home) = try await makeEngine(script: script, binary: "pi", worker: worker, tmux: tmux, errors: { XCTFail($0) })
        defer { try? FileManager.default.removeItem(at: home) }
        try await engine.start()
        try await wait { await worker.close != nil }
        let close = await worker.close
        XCTAssertEqual(close?["status"], .string("crashed"))
        XCTAssertEqual(close?["final_text"], .string("Agent process failed:\nError: model omlx/default is not loaded"))
        try await wait { await engine.snapshots().first?.mode == .idle }
        await engine.stop()
        await server.stop()
    }

    func testStdoutOnlyConfigurationDoesNotListenForHooks() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let blocker = try LocalHTTPServer { _ in .init() }
        let busy = try await blocker.start()
        let config = try DaemonConfiguration.parse("""
        [server]
        url = 'http://127.0.0.1:1'
        [hooks]
        port = \(busy)
        [[agents]]
        id = 'a'
        name = 'a'
        command = '/bin/echo'
        provider = 'stdout'
        work_dir = '/tmp'
        """)
        let engine = DaemonEngine(configuration: config, paths: TaskSquadPaths(home: home), tokens: FixtureTokens())
        try await engine.start()
        await engine.stop()
        await blocker.stop()
    }
}

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
    var imageMessages: [JSONValue] = []
    var imageAttaches: [JSONValue] = []
    var metrics: [JSONValue] = []
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
        case "/daemon/session/metrics":
            metrics.append(body)
            return .json(.object(["ok": .bool(true)]))
        case "/daemon/session/message":
            imageMessages.append(body)
            return .json(.object(["message_id": .string("img-msg")]))
        case "/daemon/messages/img-msg/attach":
            imageAttaches.append(body)
            return .json(.object([:]))
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

    private func makeEngine(script: String, binary: String = "claude", worker: InteractiveWorker, tmux: TmuxConnection, relay: String? = nil,
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
        try Data("\(hooksPort)\n".utf8).write(to: home.appendingPathComponent("hooks-port"))
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
                                  tmux: tmux, timing: timing, relayServerURL: relay, onError: errors)
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

    /// Like Go, stdout-only agents still get the hook listener (`tsq send-image`,
    /// supervisor). Unlike Go's silent goroutine, a taken port fails start clearly.
    func testStdoutOnlyConfigurationListensForHooksAndReportsABusyPort() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        func config(_ port: Int) throws -> DaemonConfiguration {
            try DaemonConfiguration.parse("""
            [server]
            url = 'http://127.0.0.1:1'
            [hooks]
            port = \(port)
            [[agents]]
            id = 'a'
            name = 'a'
            command = '/bin/echo'
            provider = 'stdout'
            work_dir = '/tmp'
            """)
        }
        let port = try await freeLoopbackPort()
        let engine = DaemonEngine(configuration: try config(port), paths: TaskSquadPaths(home: home), tokens: FixtureTokens())
        try await engine.start()
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/hooks/attach")!)
        request.httpMethod = "POST"
        request.httpBody = Data(#"{"task_id":"none","path":"/tmp/x.png"}"#.utf8)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 404, "listener up, no agent on that task")
        func hook(_ path: String, _ body: String) async throws -> (Int, String) {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
            request.httpMethod = "POST"; request.httpBody = Data(body.utf8)
            let (data, response) = try await URLSession.shared.data(for: request)
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: data, as: UTF8.self))
        }
        // Go hooks_test: verdict validation and a trigger with the supervisor disabled.
        let r1 = try await hook("/hooks/supervisor", #"{"status":"resolved"}"#); XCTAssertEqual(r1.0, 400)
        let r2 = try await hook("/hooks/supervisor", #"{"task_id":"t","status":"bogus"}"#); XCTAssertEqual(r2.0, 400)
        let r3 = try await hook("/hooks/supervisor", #"{"task_id":"t","status":"resolved","summary":"\#(String(repeating: "x", count: 1001))"}"#); XCTAssertEqual(r3.0, 400)
        let r4 = try await hook("/hooks/supervisor", #"{"task_id":"t","status":"resolved","summary":"ok"}"#); XCTAssertEqual(r4.0, 200)
        let trigger = try await hook("/hooks/trigger-supervisor", #"{"task_id":"t"}"#)
        XCTAssertEqual(trigger.0, 409)
        XCTAssertTrue(trigger.1.contains("supervisor disabled"), trigger.1)
        let r5 = try await hook("/hooks/trigger-supervisor", "{}"); XCTAssertEqual(r5.0, 400)
        await engine.stop()

        let blocker = try LocalHTTPServer { _ in .init() }
        let busy = try await blocker.start()
        let second = DaemonEngine(configuration: try config(Int(busy)), paths: TaskSquadPaths(home: home), tokens: FixtureTokens())
        do { try await second.start(); XCTFail("expected a busy-port error"); await second.stop() }
        catch { XCTAssertTrue(error.localizedDescription.contains("Could not listen for provider hooks"), error.localizedDescription) }
        await blocker.stop()
    }

    /// `tsq send-image` → POST /hooks/attach: a message, then an encrypted image upload routed to image_key.
    func testAttachHookSendsImageForCurrentTaskOnly() async throws {
        let tmux = try tmuxConnection()
        defer { Task { _ = try? await tmux.run(["kill-server"]) } }
        let script = """
        #!/bin/sh
        settings=""
        while [ $# -gt 0 ]; do [ "$1" = "--settings" ] && settings="$2"; shift; done
        url=$(grep -o 'http://localhost:[0-9]*/hooks/stop?agent=[^"]*' "$settings" | grep -v failure | head -1 | sed 's/localhost/127.0.0.1/')
        base=${url%%/hooks/*}
        printf 'READY\\n'
        IFS= read -r line
        printf 'PNG' > shot.png
        printf 'txt' > notes.txt
        curl -s -o /dev/null -w '%{http_code}\\n' -X POST "$base/hooks/attach" --data-binary "{\\"task_id\\":\\"stale\\",\\"path\\":\\"$PWD/shot.png\\"}" > codes
        curl -s -o /dev/null -w '%{http_code}\\n' -X POST "$base/hooks/attach" --data-binary "{\\"task_id\\":\\"$TSQ_TASK_ID\\",\\"path\\":\\"$PWD/notes.txt\\"}" >> codes
        curl -s -o /dev/null -w '%{http_code}\\n' -X POST "$base/hooks/attach" --data-binary "{\\"task_id\\":\\"$TSQ_TASK_ID\\"}" >> codes
        curl -s -o /dev/null -w '%{http_code}\\n' -X POST "$base/hooks/attach" --data-binary "{\\"task_id\\":\\"$TSQ_TASK_ID\\",\\"path\\":\\"$PWD/shot.png\\",\\"caption\\":\\"Look 猫\\"}" >> codes
        curl -s -X POST "$url" --data-binary '{"session_id":"cli-1","stop_reason":"end_turn","last_assistant_message":"done"}' >/dev/null
        sleep 30
        """
        let worker = InteractiveWorker()
        let errors = AttachErrors()
        let (engine, server, home) = try await makeEngine(script: script, worker: worker, tmux: tmux, errors: { message in Task { await errors.add(message) } })
        defer { try? FileManager.default.removeItem(at: home) }
        try await engine.start()
        try await wait { await worker.notifies.count >= 1 }
        await engine.stop()
        await server.stop()
        let codes = try String(contentsOf: home.appendingPathComponent("codes"), encoding: .utf8)
        XCTAssertEqual(codes.split(separator: "\n"), ["404", "500", "400", "200"])
        let messages = await worker.imageMessages
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?["message"]?.string, "Look 猫")
        XCTAssertEqual(messages.first?["type"]?.string, "output")
        XCTAssertEqual(messages.first?["session_id"]?.string, "01FIXTURESESSION")
        let attaches = await worker.imageAttaches
        XCTAssertEqual(attaches.first?["image_key"]?.string, "k")
        XCTAssertEqual(attaches.first?["filename"]?.string, "shot.png")
        XCTAssertEqual(attaches.first?["mime_type"]?.string, "image/png")
        XCTAssertNil(attaches.first?["transcript_key"])
        XCTAssertEqual(DaemonEngine.imageMIMEType(forExtension: "JPEG"), "image/jpeg")
        XCTAssertNil(DaemonEngine.imageMIMEType(forExtension: "bmp"))
    }


    /// Ported from hooks/event_test.go: /hooks/event feeds only the current task's
    /// collector (body-less Claw events too) and its lifecycle reaches the session report.
    func testEventHookFeedsCurrentTaskLifecycleIntoSessionReport() async throws {
        let tmux = try tmuxConnection()
        defer { Task { _ = try? await tmux.run(["kill-server"]) } }
        let script = """
        #!/bin/sh
        settings=""
        while [ $# -gt 0 ]; do [ "$1" = "--settings" ] && settings="$2"; shift; done
        url=$(grep -o 'http://localhost:[0-9]*/hooks/stop?agent=[^"]*' "$settings" | grep -v failure | head -1 | sed 's/localhost/127.0.0.1/')
        event=$(grep -o 'http://localhost:[0-9]*/hooks/event?agent=[^"]*' "$settings" | head -1 | sed 's/localhost/127.0.0.1/')
        stale=$(printf '%s' "$event" | sed 's/task_id=[^&]*/task_id=stale/')
        printf 'READY\\n'
        IFS= read -r line
        curl -s -X POST "$event" --data-binary '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_use_id":"x"}' > reply
        curl -s -X POST "$stale" --data-binary '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_use_id":"y"}' >/dev/null
        curl -s -X POST "$event&event=PreToolUse&tool=Glob" >/dev/null
        curl -s -X POST "$event&event=PostToolUse&tool=Glob" >/dev/null
        curl -s -X POST "$url" --data-binary '{"session_id":"cli-1","stop_reason":"end_turn","last_assistant_message":"done"}' >/dev/null
        # The server auto-closes the second paused reply, which posts the session report.
        while IFS= read -r line; do
          curl -s -X POST "$url" --data-binary '{"session_id":"cli-1","stop_reason":"end_turn","last_assistant_message":"again"}' >/dev/null
        done
        """
        let worker = InteractiveWorker()
        let (engine, server, home) = try await makeEngine(script: script, worker: worker, tmux: tmux, errors: { _ in })
        defer { try? FileManager.default.removeItem(at: home) }
        try await engine.start()
        try await wait { await worker.notifies.count >= 1 }
        try await wait { await !worker.metrics.isEmpty }
        await engine.stop()
        await server.stop()
        XCTAssertEqual(try String(contentsOf: home.appendingPathComponent("reply"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), "{}")
        let lifecycle = await worker.metrics.first?["lifecycle"]
        XCTAssertEqual(lifecycle?["tools"]?["Bash"]?["calls"]?.number, 1)
        XCTAssertEqual(lifecycle?["tools"]?["Glob"]?["calls"]?.number, 1)
        XCTAssertNil(lifecycle?["tools"]?["Read"], "a hook for a stale task was recorded")
        XCTAssertEqual(lifecycle?["source"]?.string, "hooks")
    }


    /// Go's terminal relay for regular tasks: raw PTY bytes stream to /terminal/<session>
    /// with daemon auth headers, and browser input reaches the CLI only while it is
    /// blocked on an interactive prompt (resize frames always apply).
    func testTaskStreamsToRelayAndGatesBrowserInputOnTUIBlocked() async throws {
        let tmux = try tmuxConnection()
        defer { Task { _ = try? await tmux.run(["kill-server"]) } }
        let relay = try RelayFixture()
        defer { relay.stop() }
        let script = """
        #!/bin/sh
        settings=""
        while [ $# -gt 0 ]; do [ "$1" = "--settings" ] && settings="$2"; shift; done
        url=$(grep -o 'http://localhost:[0-9]*/hooks/stop?agent=[^"]*' "$settings" | grep -v failure | head -1 | sed 's/localhost/127.0.0.1/')
        printf 'RELAY-OUT \\342\\234\\223\\n'
        IFS= read -r line
        printf 'prompt:%s\\n' "$line"
        touch ready
        IFS= read -r second
        printf 'second:%s\\n' "$second"
        curl -s -X POST "$url" --data-binary '{"session_id":"cli-1","stop_reason":"end_turn","last_assistant_message":"done"}' >/dev/null
        while IFS= read -r more; do curl -s -X POST "$url" --data-binary '{"session_id":"cli-1","stop_reason":"end_turn","last_assistant_message":"x"}' >/dev/null; done
        """
        let worker = InteractiveWorker()
        let (engine, server, home) = try await makeEngine(script: script, worker: worker, tmux: tmux, relay: "http://127.0.0.1:\(relay.port)", errors: { _ in })
        defer { try? FileManager.default.removeItem(at: home) }
        try await engine.start()
        try await wait { FileManager.default.fileExists(atPath: home.appendingPathComponent("ready").path) }
        XCTAssertEqual(relay.connectionCount, 1)
        XCTAssertEqual(relay.firstHeaders["authorization"], "Bearer fixture-token")
        XCTAssertEqual(relay.firstHeaders["x-tsq-agent"], "fixture-agent")
        try await wait { String(decoding: relay.bytes, as: UTF8.self).contains("RELAY-OUT ✓") }
        // Not blocked on a TUI prompt: browser keystrokes are dropped.
        relay.send(#"{"t":"i","d":"\#(Data("early\r".utf8).base64EncodedString())"}"#)
        try await Task.sleep(for: .milliseconds(400))
        // The CLI reports an interactive prompt; now input is forwarded.
        let port = try XCTUnwrap(try String(contentsOf: home.appendingPathComponent("hooks-port"), encoding: .utf8).split(separator: "\n").first)
        var blocked = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/hooks/tui-blocked?agent=fixture-agent&task_id=fixture-task&state=on")!)
        blocked.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: blocked)
        relay.send(#"{"t":"i","d":"\#(Data("late\r".utf8).base64EncodedString())"}"#)
        try await wait { String(decoding: relay.bytes, as: UTF8.self).contains("second:late") }
        XCTAssertFalse(String(decoding: relay.bytes, as: UTF8.self).contains("second:early"))
        try await wait { await worker.notifies.count >= 1 }
        await engine.stop()
        await server.stop()
    }


    /// Go hooks codex_test: the title-generation turn is ignored, a real turn pauses
    /// once, duplicates are dropped, and the next turn is accepted.
    func testCodexIgnoresTitleTurnAndDuplicateCallbacks() async throws {
        let tmux = try tmuxConnection()
        defer { Task { _ = try? await tmux.run(["kill-server"]) } }
        let script = """
        #!/bin/sh
        url=$(printf '%s ' "$@" | grep -o 'http://127.0.0.1:[0-9]*/hooks/codex?[^" ]*' | head -1)
        post() { curl -s -X POST "$url" -H 'Content-Type: application/json' --data-binary "$1" >/dev/null; }
        printf 'READY\\n'
        post '{"type":"agent-turn-complete","thread-id":"title-thread","turn-id":"t1","input-messages":["Generate a concise, single-line task title of at most 36 characters."],"last-assistant-message":"{\\"title\\":\\"x\\"}"}'
        post '{"type":"agent-turn-complete","thread-id":"thread-a","turn-id":"1","last-assistant-message":"REAL"}'
        post '{"type":"agent-turn-complete","thread-id":"thread-a","turn-id":"1","last-assistant-message":"DUPLICATE"}'
        n=1
        while IFS= read -r line; do n=$((n+1)); post "{\\"type\\":\\"agent-turn-complete\\",\\"thread-id\\":\\"thread-a\\",\\"turn-id\\":\\"$n\\",\\"last-assistant-message\\":\\"again\\"}"; done
        """
        let worker = InteractiveWorker()
        let (engine, server, home) = try await makeEngine(script: script, binary: "codex", worker: worker, tmux: tmux, errors: { _ in })
        defer { try? FileManager.default.removeItem(at: home) }
        try await engine.start()
        try await wait { await worker.notifies.count >= 2 }
        let notifies = await worker.notifies
        XCTAssertEqual(notifies, ["REAL", "again"])
        await engine.stop()
        await server.stop()
    }

    /// Go hooks_test (Pi): an empty agent_end defers to the exit code (crashed on
    /// exit 1); an error stop carries its text into the final reply.
    func testPiStopEmptyDefersToExitAndErrorCarriesMessage() async throws {
        let tmux = try tmuxConnection()
        for (message, expected) in [("", ""), ("Pi model call failed (google/gemini): API key not valid.", "Pi model call failed (google/gemini): API key not valid.")] {
            let reason = message.isEmpty ? "idle" : "error"
            let script = """
            #!/bin/sh
            url=$(grep -o 'http://localhost:[0-9]*' .pi/extensions/tasksquad.ts | head -1)
            query=$(grep -o '/hooks/stop?agent=[^"]*' .pi/extensions/tasksquad.ts | head -1)
            curl -s -X POST "$url$query" --data-binary '{"stop_reason":"\(reason)","message":"\(message)","transcript_path":""}' >/dev/null
            sleep 0.3
            exit 1
            """
            let worker = InteractiveWorker()
            let (engine, server, home) = try await makeEngine(script: script, binary: "pi", worker: worker, tmux: tmux, errors: { _ in })
            try await engine.start()
            try await wait { await worker.close != nil }
            let close = await worker.close
            XCTAssertEqual(close?["status"]?.string, "crashed", "exit 1 decides, whatever the hook said")
            if !expected.isEmpty { XCTAssertEqual(close?["final_text"]?.string, expected) }
            await engine.stop()
            await server.stop()
            try? FileManager.default.removeItem(at: home)
        }
    }

}

private actor AttachErrors {
    var messages: [String] = []
    func add(_ message: String) { messages.append(message) }
}

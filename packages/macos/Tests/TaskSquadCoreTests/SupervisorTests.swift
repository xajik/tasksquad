import XCTest
@testable import TaskSquadCore

private actor AgentBox {
    var agents: [SupervisedAgent]
    init(_ agent: SupervisedAgent) { agents = [agent] }
    func setIdle() { agents[0].mode = "idle" }
}

private actor Posts {
    var bodies: [(path: String, body: JSONValue)] = []
    func add(_ path: String, _ body: JSONValue) { bodies.append((path, body)) }
}

/// Ported from packages/daemon/supervisor/*_test.go, plus a byte-for-byte golden
/// (Fixtures/supervisor-golden.bin, dumped from the Go functions) and a real tmux run.
final class SupervisorTests: XCTestCase {
    func testGoldenStringsMatchGo() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil)?.appendingPathComponent("supervisor-golden.bin"))
        let expected = try String(contentsOf: url, encoding: .utf8).components(separatedBy: "\0")
        let actual = [
            Supervisor.contextBlock(agentName: #"co"der é"#, taskID: "01TASK", tmuxSession: "tsq-01TASK", logPath: "/logs/x.log",
                                    troubleshootingPath: "/tmp/t.md", snapshot: "/tmp/01TASK-snapshot.png", isImage: true),
            Supervisor.contextBlock(agentName: "coder", taskID: "01TASK", tmuxSession: "", logPath: "", troubleshootingPath: "/tmp/t.md",
                                    snapshot: "raw pane", isImage: false),
            Supervisor.printModeCommand(cli: "/usr/local/bin/codex", fullCommand: "codex -m m", promptFile: "/tmp/p q", logFile: "/tmp/l'x", daemonBinDir: "/tmp/b in"),
            Supervisor.printModeCommand(cli: "/usr/bin/claude", fullCommand: "claude --x", promptFile: "/tmp/p", logFile: "/tmp/l", daemonBinDir: "/bin dir"),
            Supervisor.printModeCommand(cli: "/usr/bin/opencode", fullCommand: "opencode -m a/b", promptFile: "/tmp/p", logFile: "/tmp/l", daemonBinDir: ""),
            Supervisor.cleanLine("abc\rdef \u{1b}[31mred\u{1b}[0m\t "),
            String(Supervisor.isSafeID("01JQZF3XKBP5TYNQWN6KV3M8AZ")),
        ]
        XCTAssertEqual(actual.count, expected.count)
        for (a, e) in zip(actual, expected) { XCTAssertEqual(a, e) }
    }

    func testResolveCLI() {
        XCTAssertEqual(Supervisor.resolveCLI(command: nil, searchPath: "/bin").0, "")
        XCTAssertEqual(Supervisor.resolveCLI(command: "", searchPath: "/bin").0, "")
        XCTAssertEqual(Supervisor.resolveCLI(command: "no-such-binary-xyz-99999", searchPath: "/bin:/usr/bin").0, "")
        let (cli, full) = Supervisor.resolveCLI(command: "sh -c echo", searchPath: "/bin:/usr/bin")
        XCTAssertFalse(cli.isEmpty); XCTAssertFalse(cli.contains(" ")); XCTAssertEqual(full, "sh -c echo")
    }

    func testPrintModeAndSafeIDs() {
        XCTAssertTrue(Supervisor.printModeCommand(cli: "/usr/bin/claude", fullCommand: "claude", promptFile: "/tmp/prompt", logFile: "/tmp/log", daemonBinDir: "/usr/local/bin")
            .contains("-p --dangerously-skip-permissions"))
        XCTAssertTrue(Supervisor.printModeCommand(cli: "/usr/bin/opencode", fullCommand: "opencode", promptFile: "/tmp/p", logFile: "/tmp/l", daemonBinDir: "/custom/bin")
            .hasPrefix("PATH=/custom/bin:$PATH "))
        XCTAssertFalse(Supervisor.printModeCommand(cli: "/usr/bin/opencode", fullCommand: "opencode", promptFile: "/tmp/p", logFile: "/tmp/l", daemonBinDir: "")
            .hasPrefix("PATH="))
        for id in ["01JQZF3XKBP5TYNQWN6KV3M8AZ", "abc123", "ABC-def_123", "a", "01234567890123456789012345678901"] { XCTAssertTrue(Supervisor.isSafeID(id), id) }
        for id in ["", "has space", #"has"quote"#, "has;semicolon", "has&ampersand", "has|pipe", "has`backtick", "has$dollar", "has(paren",
                   "has\nnewline", "123456789012345678901234567890123"] { XCTAssertFalse(Supervisor.isSafeID(id), id) }
        XCTAssertEqual(Supervisor.goDuration(minutes: 50), "50m0s")
        XCTAssertEqual(Supervisor.goBase("/a/b/"), "b"); XCTAssertEqual(Supervisor.goBase(""), ".")
    }

    func testReadOutput() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-sup-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        func read(_ content: String) throws -> String? {
            let url = dir.appendingPathComponent(UUID().uuidString)
            try Data(content.utf8).write(to: url)
            return Supervisor.readOutput(url)
        }
        XCTAssertNil(Supervisor.readOutput(dir.appendingPathComponent("missing")))
        XCTAssertNil(try read(""))
        XCTAssertNil(try read("# header\n--- CONTEXT ---\nsome context\n"))
        XCTAssertNil(try read("# header\n--- OUTPUT ---\n"))
        XCTAssertNil(try read("# header\n--- OUTPUT ---\nok\n"))
        let body = "The agent was stuck at a selection prompt. I sent option 1."
        XCTAssertEqual(try read("# header\n--- OUTPUT ---\n\(body)\n"), body)
        XCTAssertEqual(try read("# header\n--- OUTPUT ---\nAgent was running normally.\n--- SUPERVISOR TIMEOUT/EXIT: 2026-01-01T00:00:00Z ---\n"), "Agent was running normally.")
        let lines = (0..<60).map { "line \($0) of supervisor output" }
        let truncated = try XCTUnwrap(try read("# header\n--- OUTPUT ---\n" + lines.joined(separator: "\n") + "\n"))
        XCTAssertTrue(truncated.hasPrefix("…\n"))
        XCTAssertEqual(truncated.dropFirst(2).components(separatedBy: "\n").count, 50)
        XCTAssertTrue(truncated.hasSuffix("line 59 of supervisor output"))
    }

    /// Real tmux: an inactive running agent gets a supervisor session; a verdict
    /// ends it and posts the report, and a session that exits silently counts as a failure.
    func testInactiveAgentSpawnsSessionAndVerdictIsReported() async throws {
        guard let tmuxPath = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux")
        else { throw XCTSkip("tmux is required for supervisor tests") }
        let tmux = TmuxConnection(executable: tmuxPath, socketPath: "/tmp/tsq-sup-test-" + UUID().uuidString.prefix(8) + ".sock")
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-suphome-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        // A "supervisor CLI" that echoes its prompt length and waits, like a print-mode agent thinking.
        let bin = home.appendingPathComponent("bin"); try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let fake = bin.appendingPathComponent("fakesup")
        try Data("#!/bin/sh\nwc -c >/dev/null; echo 'Inspected the agent; it waits on a prompt.'; sleep 30\n".utf8).write(to: fake)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fake.path)
        _ = try await tmux.run(["-f", "/dev/null", "new-session", "-d", "-s", "tsq-01AGENT", "/bin/sleep", "120"])
        _ = try await tmux.run(["new-session", "-d", "-s", "tsq-sup-STALE", "/bin/sleep", "120"])

        var timing = Supervisor.Timing()
        timing.inactivity = .milliseconds(10); timing.check = .milliseconds(50); timing.sessionCheck = .milliseconds(50)
        timing.flushDelay = .milliseconds(10); timing.supervisorTimeout = .seconds(20)
        let posts = Posts()
        // Absolute: Go's `PATH=… cat prompt | cli` prefix only reaches `cat`, never the CLI.
        let supervisor = Supervisor(command: fake.path + " --flag", searchPath: bin.path, daemonBinDir: bin.path, paths: TaskSquadPaths(home: home), tmux: tmux,
                                    timing: timing, post: { _, path, body in await posts.add(path, body); return .object(["message_id": .string("m1")]) })
        let agent = SupervisedAgent(name: "coder", agentID: "agent-1", mode: "running", taskID: "01TASK", tmuxSession: "tsq-01AGENT",
                                    sessionID: "01SESSION", workDir: home.appendingPathComponent("proj").path, logPath: "/logs/x.log",
                                    lastActivityAt: Date().addingTimeInterval(-60))
        let box = AgentBox(agent)
        await supervisor.start { await box.agents }
        var listed = ""
        for _ in 0..<100 {
            listed = (try? await tmux.run(["list-sessions", "-F", "#{session_name}"])) ?? ""
            if listed.contains("tsq-sup-01TASK") { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(listed.contains("tsq-sup-01TASK"), listed)
        XCTAssertFalse(listed.contains("tsq-sup-STALE"), "orphan supervisor sessions are cleaned at start")
        do { try await supervisor.triggerForTask("01TASK"); XCTFail("already active") } catch {}

        let supLog = home.appendingPathComponent(".tasksquad/logs/supervisor/01TASK.log")
        for _ in 0..<100 where !((try? String(contentsOf: supLog, encoding: .utf8))?.contains("Inspected") ?? false) {
            try await Task.sleep(for: .milliseconds(50))
        }
        // The task moves on once unblocked; with the test's 10ms window a still-running
        // agent would be supervised again right after this run.
        await box.setIdle()
        await supervisor.handleVerdict(taskID: "01TASK", status: "resolved", summary: "Sent 2", found: "rate limit", action: "stopped")
        for _ in 0..<100 where await posts.bodies.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
        let first = await posts.bodies.first
        XCTAssertEqual(first?.path, "/daemon/supervisor/report")
        XCTAssertEqual(first?.body["body"]?.string, "[Supervisor] Sent 2\nStatus: resolved\nFound: rate limit\nAction: stopped")
        XCTAssertEqual(first?.body["task_id"]?.string, "01TASK")
        let log = try String(contentsOf: home.appendingPathComponent(".tasksquad/logs/supervisor/01TASK.log"), encoding: .utf8)
        XCTAssertTrue(log.hasPrefix("# TaskSquad Supervisor Log\n# agent=coder  task_id=01TASK\n# started="))
        XCTAssertTrue(log.contains("--- SUPERVISOR COMPLETE: "))
        XCTAssertTrue(log.contains("Inspected the agent"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent(".tasksquad/projects/proj/troubleshooting.md").deletingLastPathComponent().path))
        await supervisor.stop()
        let remaining = (try? await tmux.run(["list-sessions", "-F", "#{session_name}"])) ?? ""
        XCTAssertFalse(remaining.contains("tsq-sup-01TASK"), "a verdict kills the supervisor session")
        _ = try? await tmux.run(["kill-server"])
    }
}

import XCTest
@testable import TaskSquadCLI
@testable import TaskSquadCore

/// Collects what a command printed.
final class Captured: @unchecked Sendable {
    private let lock = NSLock()
    private var out = "", err = ""
    func write(_ text: String, error: Bool) { lock.lock(); if error { err += text } else { out += text }; lock.unlock() }
    var stdout: String { lock.lock(); defer { lock.unlock() }; return out }
    var stderr: String { lock.lock(); defer { lock.unlock() }; return err }
}

/// Echoes every hook request and records it, so both binaries hit the same fixture.
actor HookFixture {
    var requests: [(path: String, body: JSONValue)] = []
    var status = 200
    func setStatus(_ value: Int) { status = value }
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        requests.append((request.path, (try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null))
        // A fixed body: both binaries must print exactly what the daemon answered.
        return LocalHTTPResponse(status: status, body: Data("{\"status\":\"ok\",\"path\":\"\(request.path)\"}\n".utf8))
    }
}

/// Runs the real Go `tsq` (TSQ_GO_TSQ, built by make test-compatibility) and the
/// Swift CLI with the same argv, HOME and tmux server; stdout, stderr and the exit
/// status must match byte for byte.
final class CLIGoldenTests: PlatformTestCase {
    private var root: URL!
    private var environment: [String: String] = [:]
    private var tmux: TmuxConnection!

    override func setUp() async throws {
        guard ProcessInfo.processInfo.environment["TSQ_GO_TSQ"] != nil else { throw XCTSkip("Use make test-compatibility to build the Go tsq") }
        // Short: tmux's socket path must fit in sockaddr_un.
        root = URL(fileURLWithPath: "/tmp/tsqg-" + UUID().uuidString.prefix(6))
        try FileManager.default.createDirectory(at: root.appendingPathComponent("tmux"), withIntermediateDirectories: true)
        let path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment = ["HOME": root.path, "TMUX_TMPDIR": root.appendingPathComponent("tmux").path, "PATH": path, "LANG": "en_US.UTF-8", "TZ": "UTC"]
        tmux = TmuxConnection(executable: ExecutableLocator.find("tmux", environment: environment) ?? "tmux", environment: environment)
    }

    override func tearDown() async throws {
        if let tmux { _ = try? await tmux.run(["kill-server"]) }
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    private var cwd: String?

    private func go(_ args: [String], stdin: String = "") throws -> (Int32, String, String) {
        let process = Process()
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        process.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TSQ_GO_TSQ"]!)
        process.arguments = args
        process.environment = environment.merging(cwd.map { ["PWD": $0] } ?? [:]) { $1 }
        let out = Pipe(), err = Pipe(), input = Pipe()
        process.standardOutput = out; process.standardError = err; process.standardInput = input
        try process.run()
        input.fileHandleForWriting.write(Data(stdin.utf8)); try input.fileHandleForWriting.close()
        let o = out.fileHandleForReading.readDataToEndOfFile(), e = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: o, as: UTF8.self), String(decoding: e, as: UTF8.self))
    }

    private func swift(_ args: [String], stdin: String = "") async -> (Int32, String, String) {
        let captured = Captured()
        let context0 = CLIContext(environment: environment, stdout: { captured.write($0, error: false) }, stderr: { captured.write($0, error: true) },
                                 stdin: { Data(stdin.utf8) }, interactive: { _, _, _ in 1 }, workingDirectory: cwd ?? root.path)
        var context = context0
        context.programName = ProcessInfo.processInfo.environment["TSQ_GO_TSQ"]!
        let code = TSQCommandLine.handles(args) ? await TSQCommandLine.run(args, context: context) : await DaemonRunner.run(args, context: context)
        return (code, captured.stdout, captured.stderr)
    }

    private func assertSame(_ args: [String], stdin: String = "", compareStderr: Bool = true, file: StaticString = #filePath, line: UInt = #line) async throws {
        let g = try go(args, stdin: stdin), s = await swift(args, stdin: stdin)
        XCTAssertEqual(s.0, g.0, "exit status for \(args)", file: file, line: line)
        XCTAssertEqual(s.1, g.1, "stdout for \(args)", file: file, line: line)
        if compareStderr { XCTAssertEqual(s.2, g.2, "stderr for \(args)", file: file, line: line) }
    }

    func testSessionsPaneAndSend() async throws {
        try await assertSame(["sessions"])
        try await assertSame(["attach"])
        _ = try await tmux.run(["-f", "/dev/null", "new-session", "-d", "-s", "tsq-01ABCDEFGHIJ", "-x", "60", "-y", "8", "/bin/sh", "-c", "printf 'hello é猫\\n'; cat"])
        _ = try await tmux.run(["new-session", "-d", "-s", "personal", "/bin/sleep", "60"])
        try await Task.sleep(for: .milliseconds(200))
        try await assertSame(["sessions"])
        try await assertSame(["pane", "01ABCDEFGHIJ", "--lines", "5"])
        try await assertSame(["pane", "tsq-01ABCDEFGHIJ"])
        try await assertSame(["pane"])
        try await assertSame(["pane", "nosuch"])
        try await assertSame(["pane", "tsq-01ABCDEFGHIJ", "--lines=abc"], compareStderr: true)
        try await assertSame(["send"])
        _ = try await tmux.run(["new-session", "-d", "-s", "tsq-second", "/bin/sleep", "60"])
        try await assertSame(["attach"])
    }

    func testLogs() async throws {
        try await assertSame(["logs"])
        try await assertSame(["logs", "Coder"])
        let folder = root.appendingPathComponent(".tasksquad/logs/Coder")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("# run log\nline é\n".utf8).write(to: folder.appendingPathComponent("01TASKB.log"))
        try Data("x".utf8).write(to: folder.appendingPathComponent("01TASKA.log"))
        try Data("ignored".utf8).write(to: folder.appendingPathComponent("notes.txt"))
        try await assertSame(["logs", "Coder"])
        try await assertSame(["logs", "Coder", "01TASKB"])
        try await assertSame(["logs", "Coder", "missing"])
        try await assertSame(["logs", "../Coder", "01TASKB"])
    }

    func testHookCommandsAgainstAFixtureServer() async throws {
        let fixture = HookFixture()
        let server = try LocalHTTPServer { await fixture.handle($0) }
        let port = String(try await server.start())
        defer { Task { await server.stop() } }
        try await assertSame(["report"])
        try await assertSame(["report", "--bogus"])
        try await assertSame(["report", "--task", "T1", "--status", "resolved", "--summary", "sent 2 é", "--port", port])
        try await assertSame(["report", "-task=T1", "-status=resolved", "-summary=x", "-port", "notanumber"])
        try await assertSame(["send-image"])
        try await assertSame(["send-image", "--task", "T1", "--port", port, "--caption", "Look", "/tmp/a.png"])
        try await assertSame(["skill"])
        try await assertSame(["skill", "--name", "tsq-x", "--description", "d", "--port", port], stdin: "---\nname: tsq-x\n---\nBody")
        await fixture.setStatus(409)
        try await assertSame(["report", "--task", "T1", "--status", "resolved", "--summary", "x", "--port", port])
        try await assertSame(["report", "-h"])
        // Each pair of runs sent identical request bodies.
        let requests = await fixture.requests
        XCTAssertEqual(requests.count % 2, 0)
        for pair in stride(from: 0, to: requests.count, by: 2) {
            XCTAssertEqual(requests[pair].path, requests[pair + 1].path)
            XCTAssertEqual(requests[pair].body, requests[pair + 1].body)
        }
    }

    func testScreenshot() async throws {
        try await assertSame(["screenshot"])
        _ = try await tmux.run(["-f", "/dev/null", "new-session", "-d", "-s", "tsq-shot", "-x", "30", "-y", "4", "/bin/sh", "-c", "printf 'hi'; sleep 30"])
        let goOut = root.appendingPathComponent("go.png").path, swiftOut = root.appendingPathComponent("swift.png").path
        let g = try go(["screenshot", "tsq-shot", "--out", goOut]), s = await swift(["screenshot", "tsq-shot", "--out", swiftOut])
        XCTAssertEqual(g.0, 0); XCTAssertEqual(s.0, 0)
        XCTAssertEqual(g.1, goOut + "\n"); XCTAssertEqual(s.1, swiftOut + "\n")
        XCTAssertTrue(FileManager.default.fileExists(atPath: swiftOut))
        let failing = try go(["screenshot", "nosuch"]), mine = await swift(["screenshot", "nosuch"])
        XCTAssertEqual(mine.0, failing.0)
        XCTAssertTrue(mine.2.hasPrefix("error: ") && mine.2.hasSuffix("— session \"tsq-nosuch\" may not exist\n"), mine.2)
    }

    func testMemoryKBAndTagsOffline() async throws {
        let work = root.appendingPathComponent("proj")
        cwd = work.path
        try FileManager.default.createDirectory(at: work.appendingPathComponent("tsq/kb/deep"), withIntermediateDirectories: true)
        try Data("---\ntitle: Build steps\ntags: ci, make\n---\n\nRun make test before pushing. \(String(repeating: "padding words ", count: 20))".utf8)
            .write(to: work.appendingPathComponent("tsq/kb/build.md"))
        try Data("No frontmatter here, deploy with wrangler é.".utf8).write(to: work.appendingPathComponent("tsq/kb/deep/deploy.md"))
        for args in [["memory"], ["memory", "bogus"], ["memory", "push"], ["memory", "push", "--scope", "local"],
                     ["memory", "push", "--scope", "local", "--category", "events"], ["memory", "search"],
                     ["kb"], ["kb", "bogus"], ["kb", "search"], ["kb", "search", "make"], ["kb", "search", "WRANGLER"], ["kb", "search", "absent"],
                     ["tags"], ["tags", "pull"], ["kb", "init"], ["memory", "push", "--scope", "global", "--category", "events", "--title", "t"]] {
            try await assertSame(args, stdin: "content")
        }
        // Local pushes: same file layout and text from both (Go first, then Swift numbering -2).
        let g = try go(["memory", "push", "--scope", "local", "--category", "events", "--title", "Ship it!", "--tags", "a, b,,c"], stdin: "Body line\n\n")
        let s = await swift(["memory", "push", "--scope", "local", "--category", "events", "--title", "Ship it!", "--tags", "a, b,,c"], stdin: "Body line\n\n")
        XCTAssertEqual(g.0, 0); XCTAssertEqual(s.0, 0)
        let goPath = String(g.1.dropFirst("Saved local memory entry: ".count).dropLast())
        let swiftPath = String(s.1.dropFirst("Saved local memory entry: ".count).dropLast())
        XCTAssertEqual(swiftPath, String(goPath.dropLast(3)) + "-2.md")
        XCTAssertEqual(try String(contentsOfFile: swiftPath, encoding: .utf8), try String(contentsOfFile: goPath, encoding: .utf8))
        try await assertSame(["memory", "search", "body"])
        try await assertSame(["memory", "search", "nothing-matches"])
    }

    func testCustomerArgumentErrorsAndDoctor() async throws {
        for args in [["projects"], ["tasks"], ["tasks", "bogus", "--project", "p"], ["tasks", "list"], ["tasks", "get", "--project", "p"],
                     ["tasks", "close", "--project", "../p", "--id", "t"], ["tasks", "create", "--project", "p", "--agent", "a"],
                     ["tasks", "create", "--project", "p", "--subject", "s"], ["agents", "create", "--project", "p"],
                     ["tasks", "wait", "--project", "p", "--id", "t", "--timeout", "31m"], ["tasks", "wait", "--project", "p", "--id", "t", "--timeout", "1x"],
                     ["tasks", "list", "--project", "p", "--bogus"], ["tasks", "list", "--project", "p", "extra"],
                     ["tasks", "reply", "--project", "p", "--id", "t", "--body", "a", "--file", "f"], ["tasks", "reply", "--project", "p", "--id", "t"],
                     ["tasks", "reply", "--project", "p", "--id", "t", "--file", "/nonexistent"], ["projects", "list", "-h"]] {
            try await assertSame(args)
        }
        try Data("not = [valid".utf8).write(to: root.appendingPathComponent("bad.toml"))
        try await assertSame(["projects", "list", "--config", root.appendingPathComponent("bad.toml").path])
        // doctor reads the real login Keychain state read-only; both binaries see the same.
        try await assertSame(["doctor"])
        try await assertSame(["doctor", "--json"])
        try FileManager.default.createDirectory(at: root.appendingPathComponent(".tasksquad"), withIntermediateDirectories: true)
        try Data("[server]\nurl = 'https://example.invalid'\n".utf8).write(to: root.appendingPathComponent(".tasksquad/config.toml"))
        try await assertSame(["doctor", "--json"])
    }

    func testDaemonEntryPointFlagsAndConfigErrors() async throws {
        try await assertSame(["-version"])
        try await assertSame(["--version"])
        try await assertSame(["-bogus"])
        try await assertSame(["-h"])
        try await assertSame(["--config", root.appendingPathComponent("missing.toml").path])
        try Data("[server]\nurl='x'\n".utf8).write(to: root.appendingPathComponent("noagents.toml"))
        try await assertSame(["--config", root.appendingPathComponent("noagents.toml").path])
    }
}

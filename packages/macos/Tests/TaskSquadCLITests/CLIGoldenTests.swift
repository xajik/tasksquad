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
final class CLIGoldenTests: XCTestCase {
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

    private func go(_ args: [String], stdin: String = "") throws -> (Int32, String, String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["TSQ_GO_TSQ"]!)
        process.arguments = args
        process.environment = environment
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
        let context = CLIContext(environment: environment, stdout: { captured.write($0, error: false) }, stderr: { captured.write($0, error: true) },
                                 stdin: { Data(stdin.utf8) }, interactive: { _, _, _ in 1 })
        let code = await TSQCommandLine.run(args, context: context)
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
}

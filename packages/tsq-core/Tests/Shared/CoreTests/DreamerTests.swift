import XCTest
@testable import TaskSquadCore

private actor Calls {
    var posts: [(String, JSONValue)] = []
    var claim = true
    func add(_ path: String, _ body: JSONValue) { posts.append((path, body)) }
}

/// Ported from packages/daemon/dreamer/*_test.go, plus Fixtures/dreamer-golden.txt
/// (Go's triggerTime and math/rand, dumped with TZ=UTC) and a real tmux run.
final class DreamerTests: PlatformTestCase {
    func testTriggerTimeAndRandMatchGo() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil)?.appendingPathComponent("dreamer-golden.txt"))
        let utc = TimeZone(identifier: "UTC")!
        for line in try String(contentsOf: url, encoding: .utf8).split(separator: "\n") {
            let f = line.components(separatedBy: "|")
            if f[0] == "rand" {
                var rng = GoRand(seed: -1_234_567_890_123)
                XCTAssertEqual(String(rng.int63()), f[1]); XCTAssertEqual(String(rng.intn(14400)), f[2]); XCTAssertEqual(String(rng.intn(1 << 20)), f[3])
                continue
            }
            let at = Dreamer.triggerTime(agentID: f[0], date: f[1], windowStart: f[2], windowEnd: f[3], timeZone: utc)
            XCTAssertEqual(Int(at.timeIntervalSince1970), Int(f[4]), String(line))
        }
    }

    func testCLIResolutionPrefersDreamerThenSupervisor() throws {
        var config = DaemonConfiguration()
        XCTAssertEqual(Dreamer.resolveCLI(config, searchPath: "/bin").0, "")
        config.supervisor = .init(command: "sh -c true")
        XCTAssertEqual(Dreamer.resolveCLI(config, searchPath: "/bin:/usr/bin").1, "sh -c true")
        config.dreamer = .init(command: "cat", windowStart: "", windowEnd: "")
        XCTAssertEqual(Dreamer.resolveCLI(config, searchPath: "/bin:/usr/bin").1, "cat")
        config.dreamer = .init(command: "no-such-cli-xyz", windowStart: "", windowEnd: "")
        XCTAssertEqual(Dreamer.resolveCLI(config, searchPath: "/bin:/usr/bin").0, "")
    }

    func testPromptsAndKBDetection() throws {
        XCTAssertTrue(Dreamer.dreamPrompt(workDir: "/w", projectKey: "k", rollup: "").contains("(no memory activity recorded today)"))
        XCTAssertTrue(Dreamer.initPrompt(workDir: "/w", agentID: "a").contains("Load /tsq-kb-builder"))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-kb-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("tsq/kb/sub"), withIntermediateDirectories: true)
        XCTAssertFalse(Dreamer.kbExists(workDir: dir.path))
        try Data("x".utf8).write(to: dir.appendingPathComponent("tsq/kb/sub/notes.txt"))
        XCTAssertFalse(Dreamer.kbExists(workDir: dir.path))
        try Data("# a".utf8).write(to: dir.appendingPathComponent("tsq/kb/sub/a.md"))
        XCTAssertTrue(Dreamer.kbExists(workDir: dir.path))
    }

    /// Claims, fetches the rollup, runs the CLI in tmux, and marks the night done.
    func testNightlyRunClaimsSpawnsAndMarksTheDay() async throws {
        guard let tmuxPath = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux"),
              ExecutableLocator.find("git", environment: ["PATH": "/usr/bin:/opt/homebrew/bin"]) != nil
        else { throw XCTSkip("tmux and git are required") }
        let tmux = TmuxConnection(executable: tmuxPath, socketPath: "/tmp/tsq-dream-test-" + UUID().uuidString.prefix(8) + ".sock")
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-dreamhome-" + UUID().uuidString)
        let work = home.appendingPathComponent("proj")
        try FileManager.default.createDirectory(at: work.appendingPathComponent("tsq/kb"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try Data("# kb".utf8).write(to: work.appendingPathComponent("tsq/kb/index.md"))
        for args in [["init", "-q"], ["remote", "add", "origin", "git@GitHub.com:Org/Repo.git"]] {
            _ = try await NativeProcess.run(.init(executable: "/usr/bin/git", arguments: ["-C", work.path] + args)) { _, _ in }
        }
        let fake = home.appendingPathComponent("dreamcli")
        try Data("#!/bin/sh\ncat > \"$HOME_OUT\" 2>/dev/null; cat >/dev/null; echo dreamt\n".utf8).write(to: fake)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fake.path)
        var config = DaemonConfiguration()
        config.dreamer = .init(command: fake.path, windowStart: "00:00", windowEnd: "00:01")
        let calls = Calls()
        var timing = Dreamer.Timing(); timing.sessionCheck = .milliseconds(50); timing.sessionTimeout = .seconds(10)
        // Any time past the one-minute window qualifies.
        let dreamer = Dreamer(configuration: config, searchPath: "", daemonBinDir: "", paths: TaskSquadPaths(home: home), tmux: tmux, timing: timing,
                              now: { Calendar.current.date(bySettingHour: 23, minute: 0, second: 0, of: Date())! },
                              post: { _, path, body in await calls.add(path, body); return .object(["claimed": .bool(await calls.claim)]) },
                              get: { _, path in XCTAssertEqual(path, "/daemon/memory/rollup?period=daily"); return .object(["content": .string("fact one")]) })
        let agent = DreamAgent(agentID: "agent-1", workDir: work.path, name: "coder")
        await dreamer.maybeDream(agent)
        let posts = await calls.posts
        XCTAssertEqual(posts.first?.0, "/daemon/dream/claim")
        XCTAssertEqual(posts.first?.1["project_key"]?.string, "git@github.com:org/repo")
        let today = Dreamer.today(Calendar.current.date(bySettingHour: 23, minute: 0, second: 0, of: Date())!)
        XCTAssertEqual(posts.first?.1["date"]?.string, today)
        XCTAssertEqual(try String(contentsOf: home.appendingPathComponent(".tasksquad/dreamer/agent-1/last-run"), encoding: .utf8), today)
        let logs = try FileManager.default.contentsOfDirectory(at: home.appendingPathComponent(".tasksquad/logs/dreamer"), includingPropertiesForKeys: nil)
        let log = try String(contentsOf: try XCTUnwrap(logs.first), encoding: .utf8)
        XCTAssertTrue(log.hasPrefix("# TaskSquad Dreaming log\n# session=tsq-dream-"), log)
        XCTAssertTrue(log.contains("dreamt"), log)
        // Already ran tonight: no second claim.
        await dreamer.maybeDream(agent)
        let after = await calls.posts.count
        XCTAssertEqual(after, 1)
        _ = try? await tmux.run(["kill-server"])
    }
}

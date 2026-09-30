import XCTest
@testable import TaskSquadCore

private struct SyncTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "fixture-token" }
}

/// Worker double for GET /daemon/user/{skills,sub-agents,commands}, detail
/// fetches, and POST /daemon/skills.
private actor ResourceWorker {
    var skills: [JSONValue] = [
        .object(["id": .string("s1"), "name": .string("tsq-default-skill"), "is_default": .number(1), "etag": .string("e1"),
                 "content": .string("---\nname: tsq-default-skill\ndescription: d\n---\nBody")]),
        // Content comes from the detail endpoint, as for large team skills.
        .object(["id": .string("s2"), "team_id": .string("t1"), "name": .string("tsq-team-skill"), "auto_install": .number(1), "etag": .string("e2")]),
        .object(["id": .string("s3"), "name": .string("not-installed"), "etag": .string("e3"), "content": .string("x")]),
        .object(["id": .string("s4"), "name": .string("../escape"), "is_default": .number(1), "etag": .string("e4"), "content": .string("x")]),
    ]
    var pushed: [JSONValue] = []
    func dropSkills() { skills = [] }
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        switch request.path {
        case "/daemon/user/skills": return .json(.object(["skills": .array(skills)]))
        case "/teams/t1/skills/s2": return .json(.object(["content": .string("Team skill body"), "etag": .string("e2")]))
        case "/daemon/user/sub-agents":
            return .json(.object(["sub_agents": .array([.object(["id": .string("a1"), "name": .string("reviewer"), "is_default": .number(1), "etag": .string("ea"),
                                                                  "description": .string("Reviews \"code\""), "content": .string("---\nname: reviewer\n---\nCheck\nthe diff")])])]))
        case "/daemon/user/commands":
            return .json(.object(["commands": .array([.object(["id": .string("c1"), "name": .string("ship"), "auto_install": .number(1), "etag": .string("ec"),
                                                                "content": .string("Ship it")])])]))
        case "/daemon/skills":
            pushed.append((try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null)
            return .json(.object(["id": .string("new-skill"), "ok": .bool(true)]))
        default: return .json(.object([:]))
        }
    }
}

final class ResourceSyncTests: XCTestCase {
    private func text(_ url: URL) -> String? { try? String(contentsOf: url, encoding: .utf8) }

    func testSyncInstallsDefaultAndAutoInstallResourcesForEveryHarnessAndRemovesOnlyManagedFiles() async throws {
        let worker = ResourceWorker()
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let work = home.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        // A user-authored Codex skill with the same name must survive install and removal.
        let userCodex = work.appendingPathComponent(".agents/skills/tsq-team-skill/SKILL.md")
        try FileManager.default.createDirectory(at: userCodex.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("mine".utf8).write(to: userCodex)
        let config = try DaemonConfiguration.parse("""
        [[agents]]
        id = 'agent-a'
        name = 'A'
        command = 'claude'
        work_dir = '\(work.path)'
        [[agents]]
        id = 'agent-b'
        name = 'B'
        command = 'codex'
        work_dir = '\(work.path)'
        """)
        let sync = ResourceSync(api: WorkerAPI(baseURL: "http://127.0.0.1:\(port)"), tokens: SyncTokens(),
                                paths: TaskSquadPaths(home: home), agents: config.agents) { XCTFail($0) }
        await sync.syncAll()

        // Skills: canonical copy, every harness dir, Codex marker after frontmatter.
        XCTAssertEqual(text(work.appendingPathComponent(".tsq/skills/tsq-default-skill/SKILL.md")), "---\nname: tsq-default-skill\ndescription: d\n---\nBody")
        for base in [".claude", ".agent", ".gemini", ".pi", ".forge"] {
            XCTAssertEqual(text(work.appendingPathComponent("\(base)/skills/tsq-team-skill/SKILL.md")), "Team skill body", base)
        }
        XCTAssertEqual(text(work.appendingPathComponent(".agents/skills/tsq-default-skill/SKILL.md")),
                       "---\nname: tsq-default-skill\ndescription: d\n---\n<!-- Managed by TaskSquad skill sync. -->\nBody")
        XCTAssertEqual(text(userCodex), "mine")
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.appendingPathComponent(".tsq/skills/not-installed").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("escape").path))

        // Sub-agents: Markdown everywhere plus a managed Codex TOML.
        XCTAssertEqual(text(work.appendingPathComponent(".claude/agents/reviewer.md")), "---\nname: reviewer\n---\nCheck\nthe diff")
        XCTAssertEqual(text(work.appendingPathComponent(".codex/agents/reviewer.toml")),
                       "# Managed by TaskSquad; edits are replaced on sync.\nname = \"reviewer\"\ndescription = \"Reviews \\\"code\\\"\"\ndeveloper_instructions = \"Check\\nthe diff\"\n")
        // Commands: every command dir including OpenCode, plus the Codex skill variant.
        XCTAssertEqual(text(work.appendingPathComponent(".opencode/commands/ship.md")), "Ship it")
        XCTAssertTrue(text(work.appendingPathComponent(".agents/skills/source-command-ship/SKILL.md"))?.contains("<!-- Managed by TaskSquad command sync. -->") == true)

        // Lock files: Go's name and exact JSON bytes.
        let lock = await sync.lockURL(.skills, workDir: work.path)
        XCTAssertTrue(lock.lastPathComponent.hasPrefix("skills-") && lock.lastPathComponent.count == "skills-".count + 16 + ".lock".count)
        XCTAssertEqual(text(lock), #"{"tsq-default-skill":"e1","tsq-team-skill":"e2"}"#)

        // Deleted on the server: managed copies go, the user's file stays.
        await worker.dropSkills()
        await sync.syncAll()
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.appendingPathComponent(".tsq/skills/tsq-default-skill").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.appendingPathComponent(".claude/skills/tsq-team-skill").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.appendingPathComponent(".agents/skills/tsq-default-skill/SKILL.md").path))
        XCTAssertEqual(text(userCodex), "mine")
        XCTAssertEqual(text(lock), "{}")
        await server.stop()
    }

    func testSkillHookPushesThroughTheNamedAgent() async throws {
        let worker = ResourceWorker()
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let probe = try LocalHTTPServer { _ in .init() }
        let hooksPort = try await probe.start(); await probe.stop()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let config = try DaemonConfiguration.parse("""
        [server]
        url = 'http://127.0.0.1:\(port)'
        [hooks]
        port = \(hooksPort)
        [[agents]]
        id = 'hook-agent'
        name = 'Hook fixture'
        command = 'claude'
        work_dir = '\(home.path)'
        """)
        let engine = DaemonEngine(configuration: config, paths: TaskSquadPaths(home: home), tokens: SyncTokens())
        try await engine.start()
        func post(_ body: String, agent: String = "hook-agent") async throws -> Int {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(hooksPort)/hooks/skill?agent=\(agent)")!)
            request.httpMethod = "POST"; request.httpBody = Data(body.utf8)
            return try await NativeHTTPTransport().send(request).status
        }
        let invalidName = try await post(#"{"name":"learned","content":"x"}"#)
        XCTAssertEqual(invalidName, 400)
        let noAgent = try await post(#"{"name":"tsq-learned","content":"x"}"#, agent: "someone-else")
        XCTAssertEqual(noAgent, 404)
        let pushedStatus = try await post(#"{"name":"tsq-learned","description":"d","content":"Use tmux."}"#)
        XCTAssertEqual(pushedStatus, 200)
        let pushed = await worker.pushed
        XCTAssertEqual(pushed.first?["name"]?.string, "tsq-learned")
        XCTAssertEqual(pushed.first?["content"]?.string, "Use tmux.")
        await engine.stop(); await server.stop()
    }

    func testCodexSkillTokensGetTheExtraSubmitEnter() {
        XCTAssertTrue(DaemonEngine.opensCodexSkillPicker("$tsq-end-session-learning"))
        XCTAssertTrue(DaemonEngine.opensCodexSkillPicker("please run $tsq-foo then summarize"))
        XCTAssertFalse(DaemonEngine.opensCodexSkillPicker("$5 budget?"))
        XCTAssertFalse(DaemonEngine.opensCodexSkillPicker("costs US$tsq-x"))
        XCTAssertFalse(DaemonEngine.opensCodexSkillPicker("plain reply"))
    }
}

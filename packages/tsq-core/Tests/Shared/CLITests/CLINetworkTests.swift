import XCTest
@testable import TaskSquadCLI
@testable import TaskSquadCore

private struct StaticTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "cli-token" }
}

/// Worker double for the CLI's cloud calls (memory, tags).
private actor CloudWorker {
    var requests: [(method: String, path: String, agent: String, body: JSONValue)] = []
    var fail = false
    func setFail() { fail = true }
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        requests.append((request.method, request.path + (request.components?.percentEncodedQuery.map { "?" + $0 } ?? ""),
                         request.headers["x-tsq-agent"] ?? "", (try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null))
        if fail { return .init(status: 500, body: Data("boom".utf8)) }
        switch request.path {
        case "/daemon/memory": return .json(.object(["id": .string("m1"), "url": .string("a<b>&c/d")]))
        case "/daemon/memory/search":
            return .json(.object(["memory": .array([.object(["title": .string("Deploys"), "category": .string("events"),
                                                             "content": .string("  " + String(repeating: "x", count: 170) + "  ")])])]))
        case "/daemon/user/agents": return .json(.object(["agents": .array([.object(["id": .string("agent-1"), "team_id": .string("team-9")])])]))
        case "/teams/team-9/tags": return .json(.object(["tags": .array([.object(["name": .string("infra")]), .object(["name": .string("")]), .object(["name": .string("ci")])])]))
        default: return .init(status: 404)
        }
    }
}

/// Network paths can't be golden-tested (Go reads the real Keychain), so these
/// check the Swift CLI's requests and output against Go's code paths.
final class CLINetworkTests: PlatformTestCase {
    private func run(_ args: [String], stdin: String = "", fail: Bool = false) async throws -> (Int32, String, String, [(method: String, path: String, agent: String, body: JSONValue)]) {
        let worker = CloudWorker()
        if fail { await worker.setFail() }
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-cli-" + UUID().uuidString)
        let work = home.appendingPathComponent("proj")
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".tasksquad"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        try Data("""
        [server]
        url = 'http://127.0.0.1:\(port)'
        [[agents]]
        id = 'agent-1'
        name = 'coder'
        command = 'claude'
        work_dir = '\(work.path)/'
        """.utf8).write(to: home.appendingPathComponent(".tasksquad/config.toml"))
        let captured = Captured()
        let context = CLIContext(environment: ["HOME": home.path, "TZ": "UTC"], stdout: { captured.write($0, error: false) },
                                 stderr: { captured.write($0, error: true) }, stdin: { Data(stdin.utf8) }, workingDirectory: work.path,
                                 tokens: StaticTokens())
        let code = await TSQCommandLine.run(args, context: context)
        await server.stop()
        return (code, captured.stdout, captured.stderr, await worker.requests)
    }

    func testGlobalMemoryPushPrintsGoJSON() async throws {
        let (code, out, err, requests) = try await run(["memory", "push", "--scope", "global", "--category", "events", "--title", "T", "--tags", "x,y"], stdin: "body")
        XCTAssertEqual(code, 0, err)
        XCTAssertEqual(out, #"HTTP 200: {"id":"m1","url":"a\u003cb\u003e\u0026c/d"}"# + "\n")
        XCTAssertEqual(requests.first?.path, "/daemon/memory")
        XCTAssertEqual(requests.first?.agent, "agent-1", "work_dir with a trailing slash still matches the cwd")
        XCTAssertEqual(requests.first?.body, .object(["category": .string("events"), "title": .string("T"), "content": .string("body"),
                                                      "tags": .array([.string("x"), .string("y")])]))
    }

    func testMemorySearchMergesGlobalAndTruncatesLikeGo() async throws {
        let (code, out, _, requests) = try await run(["memory", "search", "a b&c"])
        XCTAssertEqual(code, 0)
        XCTAssertEqual(requests.first?.path, "/daemon/memory/search?q=a+b%26c")
        XCTAssertEqual(out, "[global] (events) Deploys\n    " + String(repeating: "x", count: 160) + "…\n")
    }

    func testTagsPullResolvesTeamThroughUserAgents() async throws {
        let (code, out, _, requests) = try await run(["tags", "pull"])
        XCTAssertEqual(code, 0)
        XCTAssertEqual(out, "infra\nci\n")
        XCTAssertEqual(requests.map(\.path), ["/daemon/user/agents", "/teams/team-9/tags"])
        XCTAssertEqual(requests.first?.agent, "", "user-auth endpoints carry no agent header")
    }

    func testServerErrorsUseGoWording() async throws {
        let push = try await run(["memory", "push", "--scope", "global", "--category", "events", "--title", "T"], stdin: "b", fail: true)
        XCTAssertEqual(push.0, 1); XCTAssertEqual(push.2, "error pushing memory: HTTP 500: boom\n")
        let tags = try await run(["tags", "pull"], fail: true)
        XCTAssertEqual(tags.2, "error resolving team: HTTP 500: boom\n")
        let search = try await run(["memory", "search", "q"], fail: true)
        XCTAssertEqual(search.0, 0)
        XCTAssertEqual(search.2, "global search unavailable (showing local results only): HTTP 500: boom\n")
    }
}

import XCTest
@testable import TaskSquadCLI
@testable import TaskSquadCore

private struct StaticTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "cli-token" }
}

private struct AgentsTransport: HTTPTransport {
    let body: String
    func send(_ request: URLRequest) async throws -> HTTPResult {
        XCTAssertEqual(request.url?.absoluteString, "https://api.tasksquad.ai/daemon/user/agents")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-TSQ-Agent"))
        return HTTPResult(data: Data(body.utf8), status: 200)
    }
}

/// Go's cmd/auth flows with the browser sign-in and Keychain replaced.
final class CLIAuthTests: XCTestCase {
    private func context(_ captured: Captured, home: URL, stdin: String = "", agents: String = #"{"agents":[]}"#,
                         login: @escaping @Sendable (CLIContext, String, String, String) async throws -> String) -> CLIContext {
        CLIContext(environment: ["HOME": home.path], stdout: { captured.write($0, error: false) }, stderr: { captured.write($0, error: true) },
                   stdin: { Data(stdin.utf8) }, tokens: StaticTokens(), transport: AgentsTransport(body: agents), login: login, logout: {})
    }

    func testInitWritesGoConfigFromPromptsKeepingFirstWordLikeScanln() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-init-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let captured = Captured()
        let agents = #"{"agents":[{"id":"a1","name":"Coder"},{"id":"a2","name":"Rev \"x\""}]}"#
        let code = await TSQCommandLine.run(["init"], context: context(captured, home: home, stdin: "codex --full-auto\n\n\n/work/b\n", agents: agents) { _, dashboard, api, _ in
            XCTAssertEqual(dashboard, "https://tasksquad.ai"); XCTAssertEqual(api, "https://api.tasksquad.ai"); return "me@example.com"
        })
        XCTAssertEqual(code, 0, captured.stderr)
        XCTAssertEqual(captured.stdout, """
        TaskSquad daemon setup
        ----------------------

        Step 1: Log in to TaskSquad
        Logged in as me@example.com

        Step 2: Fetching your agents from the server...
        Found 2 agent(s):
          - Coder (id: a1)
          - Rev "x" (id: a2)

        Configure agent: Coder
          CLI command [claude]:   Work directory [~/Projects]: 
        Configure agent: Rev "x"
          CLI command [claude]:   Work directory [~/Projects]: 
        Config written to \(home.path)/.tasksquad/config.toml
        Run: tsq

        """)
        let config = home.appendingPathComponent(".tasksquad/config.toml")
        XCTAssertEqual(try String(contentsOf: config, encoding: .utf8), """
        [[agents]]
        id       = "a1"
        name     = "Coder"
        command  = "codex"
        # provider = "codex"
        work_dir = "~/Projects"

        [[agents]]
        id       = "a2"
        name     = "Rev \\"x\\""
        command  = "claude"
        # provider = "claude-code"
        work_dir = "/work/b"

        """)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: config.path)[.posixPermissions] as? Int), 0o600)
        XCTAssertNoThrow(try DaemonConfiguration.load(from: config))
    }

    func testInitWithoutAgentsAndLoginLogout() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-init-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        var captured = Captured()
        let code1 = await TSQCommandLine.run(["init"], context: context(captured, home: home) { _, _, _, _ in "me@x" })
        XCTAssertEqual(code1, 1)
        XCTAssertTrue(captured.stdout.hasSuffix("No agents found. Create agents in the TaskSquad portal first.\n  https://tasksquad.ai/dashboard\n"))
        captured = Captured()
        let code2 = await TSQCommandLine.run(["login"], context: context(captured, home: home) { _, dashboard, api, _ in
            XCTAssertEqual(api, "https://tasksquad.ai", "Go falls back without a usable config"); XCTAssertEqual(dashboard, "https://tasksquad.ai"); return "me@x"
        })
        XCTAssertEqual(code2, 0)
        XCTAssertEqual(captured.stdout, "Logged in as me@x\n")
        captured = Captured()
        let code3 = await TSQCommandLine.run(["login"], context: context(captured, home: home) { _, _, _, _ in throw ConfigurationError("timed out") })
        XCTAssertEqual(code3, 1)
        XCTAssertEqual(captured.stderr, "login failed: timed out\n")
        captured = Captured()
        let code4 = await TSQCommandLine.run(["logout"], context: context(captured, home: home) { _, _, _, _ in "" })
        XCTAssertEqual(code4, 0)
        XCTAssertEqual(captured.stdout, "Logged out.\n")
    }
}

import XCTest
@testable import TaskSquadCore

/// Graph roles start Claude Code as their published sub-agent, and fall back when it is not installed.
final class GraphAgentTests: XCTestCase {
    private func task(_ role: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(#"{"graph":{"role":"\#(role)"}}"#.utf8))
    }

    func testGraphRolesMapToSubAgentsOnlyWhenInstalled() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-graph-agent-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertEqual(DaemonEngine.graphAgentArguments(provider: .claudeCode, task: try task("grade"), workDir: dir.path), [])
        let agents = dir.appendingPathComponent(".claude/agents")
        try FileManager.default.createDirectory(at: agents, withIntermediateDirectories: true)
        for name in ["tsq-graph-grader", "tsq-graph-executor", "tsq-graph-planner", "tsq-graph-agent"] {
            try Data("x".utf8).write(to: agents.appendingPathComponent("\(name).md"))
        }
        let expected = ["grade": "tsq-graph-grader", "project": "tsq-graph-grader", "execute": "tsq-graph-executor", "continue": "tsq-graph-executor", "plan": "tsq-graph-planner", "merge": "tsq-graph-planner", "decompose": "tsq-graph-planner", "repair": "tsq-graph-agent", "reconcile": "tsq-graph-agent"]
        for (role, name) in expected {
            XCTAssertEqual(DaemonEngine.graphAgentArguments(provider: .claudeCode, task: try task(role), workDir: dir.path), ["--agent", name], role)
        }
        XCTAssertEqual(DaemonEngine.graphAgentArguments(provider: .claudeCode, task: .object([:]), workDir: dir.path), [], "non-graph task")
        XCTAssertEqual(DaemonEngine.graphAgentArguments(provider: .codex, task: try task("grade"), workDir: dir.path), [])
    }

    func testIdentityFallbackReadsAnyHarnessDirectory() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-graph-identity-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertNil(DaemonEngine.graphIdentityText(task: try task("execute"), workDir: dir.path))
        let agents = dir.appendingPathComponent(".agents/agents")
        try FileManager.default.createDirectory(at: agents, withIntermediateDirectories: true)
        try Data("---\nname: tsq-graph-executor\n---\n# Identity\nYou execute one step.".utf8)
            .write(to: agents.appendingPathComponent("tsq-graph-executor.md"))
        XCTAssertEqual(DaemonEngine.graphIdentityText(task: try task("execute"), workDir: dir.path), "# Identity\nYou execute one step.")
        XCTAssertNil(DaemonEngine.graphIdentityText(task: try task("merge"), workDir: dir.path))
    }
}

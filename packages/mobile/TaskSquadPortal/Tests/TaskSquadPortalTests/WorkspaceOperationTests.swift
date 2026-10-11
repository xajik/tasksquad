import XCTest
@testable import TaskSquadPortal

/// Routes mirror `packages/worker/src/index.ts` and `packages/portal/src/lib/api.ts`.
final class WorkspaceOperationTests: XCTestCase {
    private func assert(_ op: WorkspaceOperation, _ method: String, _ path: String, _ body: [String: JSONValue] = [:], line: UInt = #line) {
        XCTAssertEqual(op.method, method, line: line)
        XCTAssertEqual(op.path.joined(separator: "/"), path, line: line)
        XCTAssertEqual(op.body, body, line: line)
    }

    func testRecordOperations() {
        assert(.update(.agents, project: "p", id: "a", values: ["role": .string("r")]), "PATCH", "teams/p/agents/a", ["role": .string("r")])
        assert(.update(.skills, project: "p", id: "s", values: [:]), "PUT", "teams/p/skills/s")
        assert(.delete(.members, project: "p", id: "u"), "DELETE", "teams/p/members/u")
        assert(.delete(.portals, project: "p", id: "x"), "DELETE", "portals/x")
        assert(.setPaused(.conveyors, project: "p", id: "c", paused: true), "PUT", "teams/p/conveyors/c", ["paused": .bool(true)])
        assert(.setPaused(.planners, project: "p", id: "l", paused: false), "PATCH", "teams/p/planners/l", ["paused": .bool(false)])
        assert(.setPaused(.agents, project: "p", id: "a", paused: true), "POST", "teams/p/agents/a/pause", ["paused": .bool(true)])
    }

    func testCreateAddsProjectAndNormalizesInboxPayload() {
        let op = WorkspaceOperation.create(.inbox, project: "p", values: ["subject": .string("s"), "save_tokens_enabled": .bool(true), "scheduled_at": .null, "close_steps": .array([])])
        assert(op, "POST", "tasks", ["subject": .string("s"), "team_id": .string("p"), "save_tokens": .object(["enabled": .bool(true), "level": .string("full")])])
        assert(.create(.portals, project: "p", values: [:]), "POST", "portals", ["team_id": .string("p")])
        assert(.create(.notes, project: "p", values: [:]), "POST", "teams/p/notes")
    }

    func testTaskOperations() {
        assert(.reply(task: "t", values: ["body": .string("b")]), "POST", "tasks/t/messages", ["body": .string("b")])
        assert(.answerPermission(task: "t", option: "Allow"), "POST", "tasks/t/messages", ["body": .string("Allow")])
        assert(.forward(task: "t", values: ["agent_id": .string("a")]), "POST", "tasks/t/forward", ["agent_id": .string("a")])
        assert(.grade(task: "t", 1), "PATCH", "tasks/t/grade", ["grade": .number(1)])
        assert(.grade(task: "t", nil), "PATCH", "tasks/t/grade", ["grade": .null])
        assert(.taskSettings(task: "t", saveTokens: ["enabled": .bool(true)]), "PATCH", "tasks/t/settings", ["save_tokens": .object(["enabled": .bool(true)])])
        assert(.closeTask("t"), "POST", "tasks/t/close")
        assert(.cancelTask("t"), "PUT", "tasks/t", ["status": .string("cancelled")])
        assert(.deleteTask("t"), "DELETE", "tasks/t")
        assert(.editMessage(task: "t", message: "m", values: ["body": .string("b")]), "PUT", "tasks/t/messages/m", ["body": .string("b")])
        assert(.deleteMessage(task: "t", message: "m"), "DELETE", "tasks/t/messages/m")
    }

    func testNoteOperations() {
        assert(.archiveNote(project: "p", note: "n", restore: false), "POST", "teams/p/notes/n/archive")
        assert(.archiveNote(project: "p", note: "n", restore: true), "DELETE", "teams/p/notes/n/archive")
        assert(.comment(project: "p", note: "n", content: "c"), "POST", "teams/p/notes/n/comments", ["content": .string("c")])
        assert(.deleteComment(project: "p", note: "n", comment: "c"), "DELETE", "teams/p/notes/n/comments/c")
        assert(.noteTask(.convert, project: "p", note: "n", values: [:]), "POST", "teams/p/notes/n/convert")
        assert(.noteTask(.critique, project: "p", note: "n", values: [:]), "POST", "teams/p/notes/n/critique")
    }

    func testAgentPlannerPortalAndProjectOperations() {
        assert(.resetAgent(project: "p", agent: "a"), "POST", "teams/p/agents/a/reset")
        assert(.createAgentToken(project: "p", agent: "a", label: "Native app"), "POST", "teams/p/tokens", ["agent_id": .string("a"), "label": .string("Native app")])
        assert(.plannerVerdict(project: "p", planner: "l", 1), "PATCH", "teams/p/planners/l", ["planner_verdict": .number(1)])
        assert(.plannerVerdict(project: "p", planner: "l", nil), "PATCH", "teams/p/planners/l", ["planner_verdict": .null])
        let conveyor = CustomerRecord(.object(["id": .string("c"), "name": .string("Nightly"), "agent_id": .string("a"), "body": .string("b"), "auto_close": .bool(true)]))
        assert(.runConveyor(project: "p", conveyor: conveyor), "POST", "tasks", ["team_id": .string("p"), "agent_id": .string("a"), "subject": .string(conveyor.title), "body": .string("b"), "auto_close": .bool(true)])
        assert(.closePortal("x"), "POST", "portals/x/close")
        assert(.createProject(values: ["name": .string("n")]), "POST", "teams", ["name": .string("n")])
        assert(.setProjectFlag(project: "p", key: "k", true), "PATCH", "teams/p", ["k": .bool(true)])
        assert(.deleteProject("p"), "DELETE", "teams/p")
    }
}

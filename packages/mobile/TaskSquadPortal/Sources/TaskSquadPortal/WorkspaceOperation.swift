import Foundation

/// Every customer mutation both apps send, named by intent. Views call these
/// instead of assembling HTTP paths and methods, so the iOS and macOS clients
/// cannot drift from each other or from the Worker routes the web portal uses.
public struct WorkspaceOperation: Sendable {
    public let path: [String]
    public let method: String
    public let body: [String: JSONValue]
    public let files: [CustomerUpload]
    public init(_ path: [String], method: String = "POST", body: [String: JSONValue] = [:], files: [CustomerUpload] = []) {
        self.path = path; self.method = method; self.body = body; self.files = files
    }
    public var key: String { WorkspaceStore.operationKey(path, method: method) }

    // MARK: Records in any section

    public static func create(_ section: WorkspaceSection, project: String, values: [String: JSONValue], files: [CustomerUpload] = []) -> Self {
        .init(WorkspacePolicy.path(section, project: project), body: WorkspacePolicy.createPayload(values, section: section, project: project), files: files)
    }
    /// Agents accept partial updates; every other editable section replaces the record.
    public static func update(_ section: WorkspaceSection, project: String, id: String, values: [String: JSONValue], files: [CustomerUpload] = []) -> Self {
        .init(WorkspacePolicy.path(section, id: id, project: project), method: section == .agents ? "PATCH" : "PUT", body: values, files: files)
    }
    public static func delete(_ section: WorkspaceSection, project: String, id: String) -> Self {
        .init(WorkspacePolicy.path(section, id: id, project: project), method: "DELETE")
    }
    /// Conveyors, planners and agents each expose pausing differently.
    public static func setPaused(_ section: WorkspaceSection, project: String, id: String, paused: Bool) -> Self {
        let path = WorkspacePolicy.path(section, id: id, project: project)
        switch section {
        case .conveyors: return .init(path, method: "PUT", body: ["paused": .bool(paused)])
        case .planners: return .init(path, method: "PATCH", body: ["paused": .bool(paused)])
        default: return .init(path + ["pause"], body: ["paused": .bool(paused)])
        }
    }

    // MARK: Tasks

    public static func reply(task: String, values: [String: JSONValue], files: [CustomerUpload] = []) -> Self { .init(["tasks", task, "messages"], body: values, files: files) }
    public static func answerPermission(task: String, option: String) -> Self { .init(["tasks", task, "messages"], body: ["body": .string(option)]) }
    public static func forward(task: String, values: [String: JSONValue]) -> Self { .init(["tasks", task, "forward"], body: values) }
    /// `nil` clears a previous grade.
    public static func grade(task: String, _ grade: Double?) -> Self { .init(["tasks", task, "grade"], method: "PATCH", body: ["grade": grade.map(JSONValue.number) ?? .null]) }
    public static func taskSettings(task: String, saveTokens: [String: JSONValue]) -> Self { .init(["tasks", task, "settings"], method: "PATCH", body: ["save_tokens": .object(saveTokens)]) }
    public static func closeTask(_ task: String) -> Self { .init(["tasks", task, "close"]) }
    public static func cancelTask(_ task: String) -> Self { .init(["tasks", task], method: "PUT", body: ["status": .string("cancelled")]) }
    public static func deleteTask(_ task: String) -> Self { .init(["tasks", task], method: "DELETE") }
    public static func editMessage(task: String, message: String, values: [String: JSONValue]) -> Self { .init(["tasks", task, "messages", message], method: "PUT", body: values) }
    public static func deleteMessage(task: String, message: String) -> Self { .init(["tasks", task, "messages", message], method: "DELETE") }

    // MARK: Notes

    public static func archiveNote(project: String, note: String, restore: Bool) -> Self {
        .init(WorkspacePolicy.path(.notes, id: note, project: project) + ["archive"], method: restore ? "DELETE" : "POST")
    }
    public static func comment(project: String, note: String, content: String) -> Self {
        .init(WorkspacePolicy.path(.notes, id: note, project: project) + ["comments"], body: ["content": .string(content)])
    }
    public static func deleteComment(project: String, note: String, comment: String) -> Self {
        .init(WorkspacePolicy.path(.notes, id: note, project: project) + ["comments", comment], method: "DELETE")
    }
    public enum NoteTask: String, Sendable { case convert, critique }
    public static func noteTask(_ kind: NoteTask, project: String, note: String, values: [String: JSONValue]) -> Self {
        .init(WorkspacePolicy.path(.notes, id: note, project: project) + [kind.rawValue], body: values)
    }

    // MARK: Agents, planners, conveyors, Portals

    public static func resetAgent(project: String, agent: String) -> Self { .init(WorkspacePolicy.path(.agents, id: agent, project: project) + ["reset"]) }
    public static func createAgentToken(project: String, agent: String, label: String) -> Self {
        .init(["teams", project, "tokens"], body: ["agent_id": .string(agent), "label": .string(label)])
    }
    /// 1 approves, 0 rejects, `nil` clears the verdict.
    public static func plannerVerdict(project: String, planner: String, _ verdict: Double?) -> Self {
        .init(WorkspacePolicy.path(.planners, id: planner, project: project), method: "PATCH", body: ["planner_verdict": verdict.map(JSONValue.number) ?? .null])
    }
    /// Starts a conveyor's task immediately with its saved subject and body.
    public static func runConveyor(project: String, conveyor: CustomerRecord) -> Self {
        .init(["tasks"], body: ["team_id": .string(project), "agent_id": .string(conveyor.text("agent_id")), "subject": .string(conveyor.title),
                                "body": .string(conveyor.text("body")), "auto_close": .bool(conveyor.flag("auto_close"))])
    }
    public static func closePortal(_ portal: String) -> Self { .init(["portals", portal, "close"]) }

    // MARK: Projects

    public static func createProject(values: [String: JSONValue]) -> Self { .init(["teams"], body: values) }
    public static func setProjectFlag(project: String, key: String, _ value: Bool) -> Self { .init(["teams", project], method: "PATCH", body: [key: .bool(value)]) }
    public static func deleteProject(_ project: String) -> Self { .init(["teams", project], method: "DELETE") }
}

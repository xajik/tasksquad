import AppKit
import Combine
import SwiftUI
import TaskSquadCore
import TaskSquadPortal

struct CustomerConfirmation: Identifiable {
    let id = UUID()
    let title: String, message: String, action: String
    var destructive = true
    let perform: @MainActor () async -> Void
}
struct CustomerText: Identifiable { let id = UUID(); let title: String, text: String }

/// What the main window is presenting, and every action a person can take in
/// it. The toolbar, context menus, the menu bar and keyboard shortcuts all call
/// the same methods here, so an action behaves the same wherever it is invoked.
@MainActor final class WorkspaceUI: ObservableObject {
    let model: CustomerWorkspaceModel
    @Published var editor: CustomerEditorRequest?
    @Published var confirmation: CustomerConfirmation?
    @Published var presentedText: CustomerText?
    /// Set to move keyboard focus to the list's search field (⌘F).
    @Published var searching = false
    /// Incremented to move keyboard focus to the reply field (⇧⌘R).
    @Published var replyFocus = 0
    @Published var terminalVisible = true
    private var subscription: AnyCancellable?

    init(model: CustomerWorkspaceModel) {
        self.model = model
        // Menu commands observe this object; forward model changes so their
        // titles and enabled state stay current.
        subscription = model.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }
    }

    var signedIn: Bool { model.profile != nil }
    var canCreate: Bool { signedIn && model.workspace.canCreate }
    var createTitle: String { model.section == .members ? "Invite Member" : "New " + Self.capitalized(model.section.itemName) }
    var selected: CustomerRecord? { signedIn ? model.selected : nil }
    var canReply: Bool { model.section == .inbox && selected != nil }
    func actions(for record: CustomerRecord) -> [RecordAction] { model.workspace.actions(for: record) }
    private static func capitalized(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }

    func dismissAll() { editor = nil; confirmation = nil; presentedText = nil }
    func refresh() { Task { await model.connect(); await model.refresh() } }
    func select(_ section: CustomerSection) { if model.section.destination != section { model.section = section } }
    func focusReply() { replyFocus += 1 }

    func newProject() { editor = .newProject(model: model) }
    func create() { guard canCreate else { return }; edit(nil) }

    func confirmSignOut() {
        confirmation = CustomerConfirmation(title: "Sign out of TaskSquad?", message: "Local agents keep running. Sign in again to see your projects.", action: "Sign Out") { [model] in
            await model.signOut()
        }
    }

    /// Runs `action` on `record`: opens its form, asks for confirmation, or sends it.
    func perform(_ action: RecordAction, on record: CustomerRecord) {
        switch action.kind {
        case .edit: edit(record)
        case .duplicate: edit(record, duplicate: true)
        case .forward: forward(record)
        case .tokenSaving: tokenSaving(record)
        case .logs: logs(record)
        case .terminal: terminalVisible.toggle()
        case .convert: sendToAgent(record, critique: false)
        case .critique: sendToAgent(record, critique: true)
        case .createToken: createToken(record)
        case .approve, .reject, .clearVerdict, .archive, .restore, .runNow, .pause, .resume, .reset, .close, .cancel, .closePortal, .leave, .delete:
            guard let operation = model.workspace.operation(action.kind, for: record) else { return }
            let kind = action.kind
            let run: @MainActor () async -> Void = { [weak self] in await self?.finish(kind, operation) }
            if let confirm = action.confirmation {
                confirmation = CustomerConfirmation(title: confirm.title, message: confirm.message, action: confirm.button, destructive: action.isDestructive, perform: run)
            } else { Task { await run() } }
        }
    }
    private func finish(_ kind: RecordAction.Kind, _ operation: WorkspaceOperation) async {
        guard let result = await model.perform(operation) else { return }
        switch kind {
        case .delete: model.selectedID = nil; await model.refresh()
        case .leave: await model.connect()
        case .runNow: if let id = result["id"]?.string { model.openTask(id) } else { await model.refresh() }
        default: await model.refresh()
        }
    }

    private func edit(_ record: CustomerRecord?, duplicate: Bool = false) {
        let section = model.section, team = model.teamID
        let updating = record != nil && !duplicate
        var fields = CustomerField.fields(for: section, record: record)
        if section == .agents, updating { fields.removeAll { $0.id != "role" } }
        if duplicate, let index = fields.firstIndex(where: { $0.id == "name" }) { fields[index].initial = .string((record?.title ?? "") + "-copy") }
        let item = Self.capitalized(section.itemName)
        let title = !updating ? createTitle : section == .agents ? "Edit Role" : "Edit " + item
        editor = CustomerEditorRequest(title: title, fields: fields, attachments: section == .inbox, phases: section == .planners, submitLabel: updating ? "Save" : section == .inbox ? "Send" : "Create",
                                        draftKey: updating || duplicate ? nil : model.workspace.draftScope("create." + section.rawValue).key) { [model] values, files in
            let operation: WorkspaceOperation = if updating, let id = record?.id { .update(section, project: team, id: id, values: values, files: files) }
                else { .create(section, project: team, values: values, files: files) }
            guard let result = await model.perform(operation) else { return false }
            if let id = result["id"]?.string { model.selectedID = id }
            await model.refresh(); return true
        }
    }
    private func forward(_ record: CustomerRecord) {
        let task = record.id
        editor = CustomerEditorRequest(title: "Forward Task", fields: [.init("agent_id", "Agent", .agent, required: true), .init("instructions", "Instructions", .multiline)], submitLabel: "Forward") { [model] body, _ in
            guard let response = await model.perform(.forward(task: task, values: body)) else { return false }
            if let id = response["task_id"]?.string { model.openTask(id) }; return true
        }
    }
    private func tokenSaving(_ record: CustomerRecord) {
        let settings = record.value["settings"]?["save_tokens"], task = record.id
        editor = CustomerEditorRequest(title: "Token Saving", fields: [.init("enabled", "Enabled", .bool, initial: settings?["enabled"] ?? .bool(false)), .init("level", "Level", .choice(["lite", "full", "ultra"]), initial: settings?["level"] ?? .string("full"))]) { [model] body, _ in
            guard await model.perform(.taskSettings(task: task, saveTokens: body)) != nil else { return false }
            await model.refresh(); return true
        }
    }
    private func logs(_ record: CustomerRecord) {
        let id = record.id
        Task {
            do {
                let logs = CustomerRecord(try await model.api().request(["tasks", id, "logs"])).records("logs")
                presentedText = CustomerText(title: "Task Logs", text: logs.map { "[\($0.text("level"))] \($0.text("body"))" }.joined(separator: "\n"))
            } catch { model.error = error.localizedDescription }
        }
    }
    private func sendToAgent(_ record: CustomerRecord, critique: Bool) {
        let project = model.teamID, note = record.id
        var fields: [CustomerField] = [.init("agent_id", "Agent", .agent, required: true), .init(critique ? "context" : "instructions", critique ? "Context" : "Instructions", .multiline), .init("include_comments", "Include comments", .bool, initial: .bool(true))]
        if !critique { fields.append(.init("auto_close", "Auto-close task", .bool, initial: .bool(false))) }
        editor = CustomerEditorRequest(title: critique ? "Ask for Critique" : "Send Note to Inbox", fields: fields, submitLabel: "Send") { [model] body, _ in
            guard let result = await model.perform(.noteTask(critique ? .critique : .convert, project: project, note: note, values: body)) else { return false }
            if let id = result["task_id"]?.string { model.openTask(id) }; return true
        }
    }
    private func createToken(_ record: CustomerRecord) {
        let operation = WorkspaceOperation.createAgentToken(project: model.teamID, agent: record.id, label: "Native app"), name = record.title
        Task {
            if let result = await model.perform(operation) {
                presentedText = CustomerText(title: "Token for \(name) · save it now", text: result["token"]?.string ?? "")
            }
        }
    }
}

/// The actions for one record, as menu items. Used by the list's context menu,
/// the detail toolbar's "More" menu and the menu bar.
struct RecordActionMenu: View {
    @ObservedObject var ui: WorkspaceUI
    let record: CustomerRecord
    var body: some View {
        let actions = ui.actions(for: record)
        ForEach(Array([RecordAction.Placement.primary, .secondary, .feedback, .destructive].enumerated()), id: \.offset) { _, placement in
            let group = actions.filter { $0.placement == placement }
            if !group.isEmpty {
                Section { ForEach(group) { RecordActionButton(ui: ui, record: record, action: $0) } }
            }
        }
    }
}

struct RecordActionButton: View {
    @ObservedObject var ui: WorkspaceUI
    let record: CustomerRecord
    let action: RecordAction
    var body: some View {
        Button(role: action.isDestructive ? .destructive : nil) { ui.perform(action, on: record) } label: {
            Label(action.title, systemImage: action.isOn ? action.systemImage + ".fill" : action.systemImage)
        }
        .disabled(ui.model.busy)
        .help(action.title)
    }
}

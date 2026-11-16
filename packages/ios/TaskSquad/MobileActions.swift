import SwiftUI
import TaskSquadPortal
import TaskSquadPortalUI

struct MobileConfirmation: Identifiable {
    let id = UUID()
    let title: String, message: String, button: String
    var destructive = true
    let perform: @MainActor () async -> Void
}
struct MobileText: Identifiable { let id = UUID(); let title: String, text: String }
struct MobileTerminal: Identifiable { let id: String }

/// Every action a person can take on a record, and what the app is presenting
/// because of one. Lists (swipe actions, context menus) and the record screen
/// (toolbar, `…` menu) call the same `perform`, so an action behaves the same
/// wherever it is started.
@MainActor final class MobileActions: ObservableObject {
    let model: WorkspaceStore
    @Published var editor: MobileEditorRequest?
    @Published var confirmation: MobileConfirmation?
    @Published var text: MobileText?
    @Published var terminal: MobileTerminal?
    /// The last action's failure, shown on the screen that started it.
    @Published var error: String?
    /// Incremented when an action changed data; screens refresh and give feedback.
    @Published private(set) var changes = 0
    /// Called after a record was deleted or left, so its screen can close.
    var onRemoved: ((String) -> Void)?
    var onOpenTask: ((String) -> Void)?
    /// Refreshes the open record after a change.
    var refreshDetail: (@MainActor () async -> Void)?

    init(model: WorkspaceStore) { self.model = model }
    func dismissAll() { editor = nil; confirmation = nil; text = nil; terminal = nil; error = nil }

    var createTitle: String { model.section == .members ? "Invite member" : "New " + model.section.itemName }
    func create(opened: @escaping (String) -> Void) {
        let section = model.section, project = model.projectID, context = model.context
        model.error = nil
        editor = MobileEditorRequest(title: createTitle, fields: WorkspaceField.fields(for: section), draftKey: model.draftScope("create." + section.rawValue).key, eligibleAgentsOnly: section == .portals, attachments: section == .inbox, phases: section == .planners, submitLabel: section == .inbox ? "Send" : "Create") { [model] body, files in
            guard context == model.context, let result = await model.perform(.create(section, project: project, values: body, files: files)) else { return false }
            await model.refresh()
            let record = CustomerRecord(result)
            if !record.id.isEmpty { opened(record.id) }
            return true
        }
    }

    func perform(_ action: RecordAction, on record: CustomerRecord) {
        error = nil
        switch action.kind {
        case .edit: edit(record)
        case .duplicate: edit(record, duplicate: true)
        case .forward: forward(record)
        case .tokenSaving: tokenSaving(record)
        case .logs: logs(record)
        case .terminal: if !record.text("session_id").isEmpty { terminal = MobileTerminal(id: record.text("session_id")) }
        case .convert: noteTask(record, .convert)
        case .critique: noteTask(record, .critique)
        case .createToken: createToken(record)
        case .approve, .reject, .clearVerdict, .archive, .restore, .runNow, .pause, .resume, .reset, .close, .cancel, .closePortal, .leave, .delete:
            guard let operation = model.operation(action.kind, for: record) else { return }
            let kind = action.kind, id = record.id
            let run: @MainActor () async -> Void = { [weak self] in await self?.finish(kind, id, operation) }
            if let confirm = action.confirmation {
                confirmation = MobileConfirmation(title: confirm.title, message: confirm.message, button: confirm.button, destructive: action.isDestructive, perform: run)
            } else { Task { await run() } }
        }
    }
    private func finish(_ kind: RecordAction.Kind, _ id: String, _ operation: WorkspaceOperation) async {
        guard let result = await model.perform(operation) else { error = model.error; return }
        switch kind {
        case .delete: onRemoved?(id); await model.refresh()
        case .leave: onRemoved?(id); await model.connect()
        case .runNow:
            await model.refresh()
            if let task = result["id"]?.string { onOpenTask?(task) }
        default: await changed()
        }
        changes += 1
    }
    private func changed() async { await model.refresh(); await refreshDetail?() }

    private func edit(_ record: CustomerRecord, duplicate: Bool = false) {
        let section = model.section, project = model.projectID, id = record.id
        var fields = WorkspaceField.fields(for: section, record: record)
        if section == .agents { fields.removeAll { $0.id != "role" } }
        if duplicate, let index = fields.firstIndex(where: { $0.id == "name" }) { fields[index].initial = .string(record.title + "-copy") }
        let title = duplicate ? "New " + section.itemName : section == .agents ? "Edit role" : "Edit " + section.itemName
        editor = MobileEditorRequest(title: title, fields: fields, submitLabel: duplicate ? "Create" : "Save") { [weak self, model] body, files in
            let operation: WorkspaceOperation = duplicate ? .create(section, project: project, values: body, files: files) : .update(section, project: project, id: id, values: body, files: files)
            guard await model.perform(operation) != nil else { return false }
            await self?.changed(); return true
        }
    }
    private func forward(_ record: CustomerRecord) {
        let id = record.id
        editor = MobileEditorRequest(title: "Forward task", fields: [.init("agent_id", "Agent", .agent, required: true), .init("instructions", "Instructions", .multiline)], submitLabel: "Forward") { [weak self, model] body, _ in
            guard let result = await model.perform(.forward(task: id, values: body)) else { return false }
            await model.refresh()
            if let task = result["task_id"]?.string { self?.onOpenTask?(task) }
            return true
        }
    }
    private func tokenSaving(_ record: CustomerRecord) {
        let settings = record.value["settings"]?["save_tokens"], id = record.id
        editor = MobileEditorRequest(title: "Token saving", fields: [.init("enabled", "Enabled", .bool, initial: settings?["enabled"] ?? .bool(false)), .init("level", "Level", .choice(["lite", "full", "ultra"]), initial: settings?["level"] ?? .string("full"))]) { [weak self, model] body, _ in
            guard await model.perform(.taskSettings(task: id, saveTokens: body)) != nil else { return false }
            await self?.changed(); return true
        }
    }
    private func logs(_ record: CustomerRecord) {
        let id = record.id
        Task {
            do {
                let logs = CustomerRecord(try await model.api.request(["tasks", id, "logs"])).records("logs")
                text = MobileText(title: "Task logs", text: logs.isEmpty ? "No log entries yet." : logs.map { $0.text("body") }.joined(separator: "\n"))
            } catch { self.error = error.localizedDescription }
        }
    }
    private func noteTask(_ record: CustomerRecord, _ kind: WorkspaceOperation.NoteTask) {
        let project = model.projectID, id = record.id, convert = kind == .convert
        editor = MobileEditorRequest(title: convert ? "Send to Inbox" : "Request critique", fields: [.init("agent_id", "Agent", .agent, required: true), .init(convert ? "instructions" : "context", "Instructions", .multiline), .init("include_comments", "Include comments", .bool, initial: .bool(true))], submitLabel: "Send") { [weak self, model] body, _ in
            guard await model.perform(.noteTask(kind, project: project, note: id, values: body)) != nil else { return false }
            await self?.changed(); return true
        }
    }
    private func createToken(_ record: CustomerRecord) {
        let operation = WorkspaceOperation.createAgentToken(project: model.projectID, agent: record.id, label: "iOS app"), name = record.title
        Task {
            if let result = await model.perform(operation) { text = MobileText(title: "Token for \(name)", text: result["token"]?.string ?? "") }
            else { error = model.error }
        }
    }
}

/// A record's actions as menu items, grouped: primary, secondary, feedback, destructive.
struct MobileActionMenu: View {
    @ObservedObject var actions: MobileActions
    let record: CustomerRecord
    var excluding: Set<RecordAction.Kind> = []
    var body: some View {
        let all = actions.model.actions(for: record).filter { !excluding.contains($0.kind) }
        ForEach(Array([RecordAction.Placement.primary, .secondary, .feedback, .destructive].enumerated()), id: \.offset) { _, placement in
            let group = all.filter { $0.placement == placement }
            if !group.isEmpty {
                Section { ForEach(group) { action in MobileActionButton(actions: actions, record: record, action: action) } }
            }
        }
    }
}
struct MobileActionButton: View {
    @ObservedObject var actions: MobileActions
    let record: CustomerRecord
    let action: RecordAction
    var body: some View {
        Button(role: action.isDestructive ? .destructive : nil) { actions.perform(action, on: record) } label: {
            Label(action.title, systemImage: action.isOn ? action.systemImage + ".fill" : action.systemImage)
        }.disabled(actions.model.busy)
    }
}

/// Sheets and confirmation dialogs started by `MobileActions`.
struct MobileActionPresentations: ViewModifier {
    @ObservedObject var actions: MobileActions
    func body(content: Content) -> some View {
        content
            .sheet(item: $actions.editor) { request in
                MobileEditor(model: actions.model, request: request)
                    // Short forms (forward, comment, edit role) open at half height.
                    .presentationDetents(request.fields.count <= 3 && !request.attachments && !request.phases ? [.medium, .large] : [.large])
            }
            .sheet(item: $actions.text) { value in
                NavigationStack {
                    ScrollView { Text(value.text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding() }
                        .navigationTitle(value.title).navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = value.text } }
                            ToolbarItem(placement: .confirmationAction) { Button("Done") { actions.text = nil } }
                        }
                }.presentationDetents([.medium, .large])
            }
            .sheet(item: $actions.terminal) { value in
                NavigationStack {
                    PortalTerminalScreen(sessionID: value.id, api: actions.model.api)
                        .navigationTitle("Task terminal").navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { actions.terminal = nil } } }
                }
            }
            .confirmationDialog(actions.confirmation?.title ?? "", isPresented: Binding(get: { actions.confirmation != nil }, set: { if !$0 { actions.confirmation = nil } }),
                                titleVisibility: .visible, presenting: actions.confirmation) { value in
                Button(value.button, role: value.destructive ? .destructive : nil) { Task { await value.perform() } }
                Button("Cancel", role: .cancel) { }
            } message: { Text($0.message) }
            .sensoryFeedback(.success, trigger: actions.changes)
    }
}

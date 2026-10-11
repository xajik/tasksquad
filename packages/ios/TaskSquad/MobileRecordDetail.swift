import TaskSquadPortalUI
import SwiftUI
import TaskSquadPortal

struct MobileRecordDetail: View {
    @ObservedObject var model: WorkspaceStore
    let id: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @StateObject private var detailStore = RecordDetailStore()
    private var detail: CustomerRecord? { detailStore.detail }
    private var messages: [CustomerRecord] { model.section == .notes ? detailStore.comments : detailStore.messages }
    private var related: [CustomerRecord] { detailStore.related }
    @State private var mutationError: String?
    @State private var error: String?
    @State private var editor: MobileEditorRequest?
    @State private var confirm = ""
    @State private var showConfirmation = false
    @State private var logs: [CustomerRecord] = []
    @State private var showLogs = false
    @State private var terminalPresented = false
    @State private var transcript: String?
    private var record: CustomerRecord? { detail ?? model.records.first { $0.id == id } }
    private var taskSection: Bool { [.inbox, .supervisor].contains(model.section) }
    private var live: Bool { ["pending", "running"].contains(record?.status ?? "") }
    var body: some View {
        Group {
            if model.section == .portals, let record { portal(record) }
            else { List {
                if let record {
                    Section {
                        Text(record.title).font(.title3.bold()).textSelection(.enabled)
                        if !record.status.isEmpty { TSQBadge(status: record.status).accessibilityIdentifier("record-status") }
                        if !record.text("agent_id").isEmpty { Text(model.agentName(record.text("agent_id"))).font(.caption) }
                    }
                    if taskSection { conversation }
                    else { contents(record); actions(record) }
                    if !related.isEmpty { Section("Related tasks") { ForEach(related) { Text($0.title + " · " + $0.status) } } }
                } else { ProgressView("Loading…") }

            } }
        }
        .safeAreaInset(edge: .bottom) {
            if model.section != .portals, let error = mutationError ?? error ?? model.error { Text(error).font(.footnote).foregroundStyle(MobileTheme.destructive).padding().frame(maxWidth: .infinity).background(.regularMaterial).accessibilityIdentifier("detail-error") }
        }
        .navigationTitle(model.section == .portals ? model.agentName(record?.text("agent_id") ?? "") : model.section.rawValue)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if taskSection { Menu {
                    Button("Reply") { reply() }
                    Button("Logs") { Task { await loadLogs() } }
                    Button("Forward to agent") { forward() }
                    Button("Mark helpful") { Task { await run(.grade(task: id, 1)) } }
                    Button("Mark unhelpful") { Task { await run(.grade(task: id, 0)) } }
                    Button("Cancel task", role: .destructive) { ask("Cancel task") }
                    Button("Delete task", role: .destructive) { ask("Delete item") }
                    if !(record?.text("session_id") ?? "").isEmpty { Button("Terminal") { terminalPresented = true } }
                    Button("Close task", role: .destructive) { ask("Close task") }
                } label: { MobileIcon(name: "ellipsis") }.accessibilityLabel("Task actions") }
                else if model.section == .portals, live { Button("Close", role: .destructive) { ask("Close Portal") }.accessibilityIdentifier("close-portal").disabled(model.busy) }
            }
        }
        .task(id: "\(model.context):\(id):\(phase)") {
            guard phase == .active else { return }
            await refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(WorkspacePolicy.pollInterval(isPro: model.isPro))) } catch { return }
                await refresh()
            }
        }
        .sheet(item: $editor) { MobileEditor(model: model, request: $0) }
        .sheet(isPresented: Binding(get: { transcript != nil }, set: { if !$0 { transcript = nil } })) {
            NavigationStack { ScrollView { Text(transcript ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled).padding() }.navigationTitle("Transcript").toolbar { Button("Done") { transcript = nil } } }
        }
        .sheet(isPresented: $showLogs) { NavigationStack { List(logs) { Text($0.text("body")).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }.navigationTitle("Task logs").toolbar { Button("Done") { showLogs = false } } } }
        .sheet(isPresented: $terminalPresented) { NavigationStack {
            if let session = record?.text("session_id"), !session.isEmpty { PortalTerminalScreen(sessionID: session, api: terminalAPI).navigationTitle("Task terminal").toolbar { Button("Done") { terminalPresented = false } } }
        } }
        .alert(confirm, isPresented: $showConfirmation) {
            Button(confirm, role: .destructive) { let action = confirm; Task { await confirmed(action) } }
            Button("Cancel", role: .cancel) { }
        } message: { Text(confirm == "Delete item" ? "This permanently removes the record." : "This changes the remote work. Completed records remain available.") }
    }
    private func ask(_ action: String) { confirm = action; showConfirmation = true }

    private var terminalAPI: PortalAPI { PortalAPI(baseURL: model.api.baseURL) { force in try await model.api.accessToken(forceRefresh: force) } }
    @ViewBuilder private func portal(_ record: CustomerRecord) -> some View {
        VStack(spacing: 0) {
            if record.status == "running", !record.text("session_id").isEmpty {
                PortalTerminalScreen(sessionID: record.text("session_id"), api: terminalAPI).id(record.text("session_id"))
            } else {
                ContentUnavailableView(record.status == "pending" ? "Waiting for agent" : record.status == "running" ? "Starting terminal" : record.status == "failed" ? "Portal failed" : "Portal completed", systemImage: "terminal", description: Text(live ? "The terminal will connect when the agent starts the session." : "This session has ended."))
                Text(record.status.capitalized).accessibilityIdentifier("portal-status")
            }
            if let error = mutationError ?? error ?? model.error { Text(error).foregroundStyle(MobileTheme.destructive).padding().accessibilityIdentifier("detail-error") }
        }
    }
    private var conversation: some View {
        Group {
            Section("Conversation") {
                ForEach(messages) { message in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Text(message.text("role").capitalized).font(.caption.bold()); Spacer(); Text(message.date, style: .time).font(.caption).foregroundStyle(MobileTheme.mutedForeground) }
                        MarkdownContent(message.text("body"), copy: { UIPasteboard.general.string = $0 }).accessibilityIdentifier("message-" + message.id)
                        if !message.text("type").isEmpty { Text(message.text("type").replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(MobileTheme.mutedForeground) }
                        if message.number("scheduled_at") > Date().timeIntervalSince1970*1000 { Text("Scheduled reply").font(.caption).foregroundStyle(MobileTheme.warning) }
                        if !message.text("transcript_key").isEmpty { Button("View transcript") { Task {
                            do { transcript = String(decoding: try await model.api.data(["tasks", id, "messages", message.id, "transcript"]), as: UTF8.self) } catch { self.error = error.localizedDescription }
                        } } }
                        if message.text("type") == "permission_request", message.text("interaction_status") == "pending" {
                            ForEach(permissionOptions(message), id: \.self) { option in
                                Button(option) { Task { await run(.answerPermission(task: id, option: option)) } }.disabled(model.busy)
                            }
                        }
                        ForEach(message.records("attachments")) { attachment in MobileAttachment(api: model.api, path: ["tasks", id, "messages", message.id, "attachments", attachment.id], name: attachment.text("filename")) }
                    }.padding(.vertical, 5)
                }
            }
            Section { Button("Reply") { reply() }.accessibilityIdentifier("reply-task") }
        }
    }
    @ViewBuilder private func contents(_ record: CustomerRecord) -> some View {
        ForEach(["description", "content", "body", "role", "category", "frequency", "timezone", "email"], id: \.self) { key in
            if !record.text(key).isEmpty { Section(key.capitalized) { MarkdownContent(record.text(key), copy: { UIPasteboard.general.string = $0 }) } }
        }
        if model.section == .agents {
            Section("Availability") {
                Text(record.flag("paused") ? "Paused" : "Not paused")
                if record.number("last_seen") > 0 { Text("Last seen " + Date(timeIntervalSince1970: record.number("last_seen")/1000).formatted()) }
            }
        }
        if model.section == .planners {
            Section("Phases") { ForEach(record.records("phases")) { phase in VStack(alignment: .leading) { Text(phase.title); Text(phase.status).font(.caption); if !phase.text("last_response").isEmpty { Text(phase.text("last_response")) } } } }
        }
        if model.section == .notes {
            Section("Comments") { ForEach(messages) { Text($0.text("content")) }; Button("Add comment") { comment() } }
        }
    }
    @ViewBuilder private func actions(_ record: CustomerRecord) -> some View {
        Section("Actions") {
            if [.notes, .skills, .subAgents, .commands, .conveyors].contains(model.section), model.section == .notes || model.canManage {
                if !record.flag("is_default") { Button("Edit") { edit(record) } }
            }
            if model.section == .notes {
                Button(model.archived ? "Restore note" : "Archive note") { Task { await run(.archiveNote(project: model.projectID, note: id, restore: model.archived)) } }
                Button("Send to Inbox") { noteTask(.convert) }
                Button("Ask for critique") { noteTask(.critique) }
            }
            if model.canManage, [.conveyors, .planners, .agents].contains(model.section) {
                Button(record.flag("paused") ? "Resume" : "Pause") { Task {
                    await run(.setPaused(model.section, project: model.projectID, id: id, paused: !record.flag("paused")))
                } }
            }
            if model.section == .agents, model.canManage {
                Button("Edit role") { editor = MobileEditorRequest(title: "Edit agent role", fields: [.init("role", "Role", .multiline, initial: .string(record.text("role")))]) { body, _ in
                    guard await model.perform(.update(.agents, project: model.projectID, id: id, values: body)) != nil else { return false }; await model.refresh(); await refresh(); return true
                } }
                Button("Reset agent") { ask("Reset agent") }
            }
            if model.section == .notes || (model.canManage && !record.flag("is_default") && [.skills,.subAgents,.commands,.conveyors,.planners,.agents].contains(model.section)) || (model.section == .members && model.isOwner) {
                Button("Delete", role: .destructive) { ask("Delete item") }
            }
            if model.section == .planners { Button("Approve planner") { Task { await run(.plannerVerdict(project: model.projectID, planner: id, 1)) } }; Button("Reject planner") { Task { await run(.plannerVerdict(project: model.projectID, planner: id, 0)) } } }
        }
    }
    private func permissionOptions(_ message: CustomerRecord) -> [String] {
        guard let data = message.text("json_payload").data(using: .utf8), let payload = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [] }
        return (payload["options"]?.array ?? []).compactMap(\.string)
    }
    private func refresh() async {
        await detailStore.refresh(workspace: model, id: id)
        error = detailStore.error
    }
    /// Sends the operation and refreshes the workspace and this record on success.
    private func run(_ operation: WorkspaceOperation) async {
        if await model.perform(operation) != nil { await model.refresh(); await refresh() }
    }
    private func confirmed(_ action: String?) async {
        guard let action else { return }
        let section = model.section, project = model.projectID
        let operation: WorkspaceOperation = switch action {
        case "Delete item": .delete(section, project: project, id: id)
        case "Cancel task": .cancelTask(id)
        case "Reset agent": .resetAgent(project: project, agent: id)
        case "Close Portal": .closePortal(id)
        default: .closeTask(id)
        }
        if await model.perform(operation) != nil {
            mutationError = nil; await model.refresh()
            if action == "Delete item" { dismiss() } else { await refresh() }
        } else { mutationError = model.error }
    }
    private func forward() {
        editor = MobileEditorRequest(title: "Forward task", fields: [.init("agent_id", "Agent", .agent, required: true), .init("instructions", "Instructions", .multiline)]) { body, _ in
            guard await model.perform(.forward(task: id, values: body)) != nil else { return false }; await model.refresh(); return true
        }
    }
    private func reply() {
        editor = MobileEditorRequest(title: "Reply", fields: [.init("body", "Message", .multiline, required: true), .init("scheduled_at", "Schedule reply", .date, initial: .null)], draftKey: model.draftScope("reply." + id).key, attachments: true, submitLabel: "Send") { body, files in
            guard await model.perform(.reply(task: id, values: body, files: files)) != nil else { return false }; await refresh(); return true
        }
    }
    private func edit(_ record: CustomerRecord) {
        let section = model.section
        editor = MobileEditorRequest(title: "Edit " + section.rawValue, fields: WorkspaceField.fields(for: section, record: record)) { body, files in
            guard await model.perform(.update(section, project: model.projectID, id: id, values: body, files: files)) != nil else { return false }; await model.refresh(); await refresh(); return true
        }
    }
    private func comment() {
        editor = MobileEditorRequest(title: "Add comment", fields: [.init("content", "Comment", .multiline, required: true)]) { body, _ in
            guard await model.perform(.comment(project: model.projectID, note: id, content: body["content"]?.string ?? "")) != nil else { return false }; await refresh(); return true
        }
    }
    private func noteTask(_ kind: WorkspaceOperation.NoteTask) {
        let action = kind.rawValue
        editor = MobileEditorRequest(title: action == "convert" ? "Send to Inbox" : "Request critique", fields: [.init("agent_id", "Agent", .agent, required: true), .init(action == "convert" ? "instructions" : "context", "Instructions", .multiline), .init("include_comments", "Include comments", .bool, initial: .bool(true))]) { body, _ in
            guard await model.perform(.noteTask(kind, project: model.projectID, note: id, values: body)) != nil else { return false }; await refresh(); return true
        }
    }
    private func loadLogs() async {
        do { logs = CustomerRecord(try await model.api.request(["tasks", id, "logs"])).records("logs"); showLogs = true } catch { self.error = error.localizedDescription }
    }
}

private struct MobileAttachment: View {
    let api: CustomerAPI
    let path: [String]
    let name: String
    @State private var image: UIImage?
    @State private var mutationError: String?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading) {
            if let image { Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 250).accessibilityLabel(name) }
            else { Label(name, systemImage: "photo") }
            if let error { Text(error).font(.caption).foregroundStyle(MobileTheme.destructive) }
        }.task { do { image = UIImage(data: try await api.data(path)) } catch { self.error = error.localizedDescription } }
    }
}

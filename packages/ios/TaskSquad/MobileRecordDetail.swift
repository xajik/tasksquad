import TaskSquadPortalUI
import SwiftUI
import TaskSquadPortal

struct MobileRecordDetail: View {
    @ObservedObject var model: WorkspaceStore
    let id: String
    var isActive = true
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
    private var live: Bool { PortalLifecycle.isLive(record?.status ?? "") }
    var body: some View {
        Group {
            if model.section == .portals, let record { portal(record) }
            else { List {
                if let record {
                    Section {
                        Text(model.displayTitle(record)).font(.title3.bold()).textSelection(.enabled)
                        if !record.status.isEmpty { TSQBadge(status: record.status).accessibilityIdentifier("record-status") }
                        if !record.text("agent_id").isEmpty { LabeledContent("Agent", value: model.agentName(record.text("agent_id"))) }
                    }
                    if taskSection { conversation }
                    else { contents(record) }
                    if !related.isEmpty { Section("Related tasks") { ForEach(related) { Text($0.title + " · " + $0.status) } } }
                } else { ProgressView("Loading…") }

            }
            .scrollContentBackground(.hidden).background(MobileTheme.background) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if model.section != .portals {
                VStack(alignment: .trailing, spacing: 0) {
                    if let record, let primary = primaryAction(record) { primary }
                    if let error = mutationError ?? error ?? model.error { TSQErrorBanner(error, identifier: "detail-error").padding(.horizontal).padding(.vertical, 8).frame(maxWidth: .infinity).background(.regularMaterial) }
                }.frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .navigationTitle(model.section == .portals ? model.agentName(record?.text("agent_id") ?? "") : model.section.mobileTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // A live Portal's terminal fills the screen, so its one action
                // stays in the bar rather than floating over the output.
                if model.section == .portals { if live { Button("Close", role: .destructive) { ask("Close Portal") }.accessibilityIdentifier("close-portal").disabled(model.busy) } }
                else if let record, hasSecondaryActions(record) { MobileMoreMenu { secondaryActions(record) } }
            }
        }
        .task(id: "\(model.context):\(id):\(phase):\(isActive)") {
            guard phase == .active, isActive else { return }
            // The shell polls only the visible route. Utility screens pause this
            // detail poller; the sidebar leaves it running.
            await model.poll(refreshWorkspace: false) { await refresh() }
        }
        .sheet(item: $editor) { MobileEditor(model: model, request: $0) }
        .sheet(isPresented: Binding(get: { transcript != nil }, set: { if !$0 { transcript = nil } })) {
            NavigationStack { ScrollView { Text(transcript ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled).padding() }.navigationTitle("Transcript").toolbar { Button("Done") { transcript = nil } } }
        }
        .sheet(isPresented: $showLogs) { NavigationStack { List(logs) { Text($0.text("body")).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }.navigationTitle("Task logs").toolbar { Button("Done") { showLogs = false } } } }
        .sheet(isPresented: $terminalPresented) { NavigationStack {
            if let session = record?.text("session_id"), !session.isEmpty { PortalTerminalScreen(sessionID: session, api: model.api).navigationTitle("Task terminal").toolbar { Button("Done") { terminalPresented = false } } }
        } }
        .alert(confirm, isPresented: $showConfirmation) {
            Button(confirm, role: .destructive) { let action = confirm; Task { await confirmed(action) } }
            Button("Cancel", role: .cancel) { }
        } message: { Text(confirm == "Delete item" ? "This permanently removes the record." : "This changes the remote work. Completed records remain available.") }
    }
    private func ask(_ action: String) { confirm = action; showConfirmation = true }

    @ViewBuilder private func portal(_ record: CustomerRecord) -> some View {
        VStack(spacing: 0) {
            let lifecycle = PortalLifecycle(record)
            if let session = lifecycle.sessionID {
                PortalTerminalScreen(sessionID: session, api: model.api).id(session)
            } else {
                TSQEmptyState(icon: "monitor", title: lifecycle.title, message: lifecycle.message)
                TSQBadge(status: record.status).accessibilityIdentifier("portal-status")
            }
            if let error = mutationError ?? error ?? model.error { TSQErrorBanner(error, identifier: "detail-error").padding() }
        }
    }
    private var conversation: some View {
        Group {
            Section("Conversation") {
                ForEach(messages) { message in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack { Text(message.text("role").capitalized).font(.caption.bold()); Spacer(); Text(message.date, style: .time).font(.caption).foregroundStyle(MobileTheme.mutedForeground) }
                        if ["tool_call", "tool_result"].contains(message.text("type")) {
                            // Raw tool JSON: compact monospace, not prose.
                            Text(message.text("body")).font(.system(.footnote, design: .monospaced)).foregroundStyle(MobileTheme.mutedForeground)
                                .lineLimit(6).textSelection(.enabled).accessibilityIdentifier("message-" + message.id)
                        } else {
                            MarkdownContent(message.text("body"), copy: { UIPasteboard.general.string = $0 }).accessibilityIdentifier("message-" + message.id)
                        }
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
        }
    }
    @ViewBuilder private func contents(_ record: CustomerRecord) -> some View {
        ForEach(["description", "content", "body", "role", "category", "frequency", "timezone", "email"], id: \.self) { key in
            if !record.text(key).isEmpty { Section(key.capitalized) { MarkdownContent(Self.withoutFrontMatter(record.text(key)), copy: { UIPasteboard.general.string = $0 }) } }
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
            Section("Comments") {
                if messages.isEmpty { Text("No comments yet").foregroundStyle(MobileTheme.mutedForeground) }
                ForEach(messages) { Text($0.text("content")) }
            }
        }
    }
    private var editable: Bool { [.notes, .skills, .subAgents, .commands, .conveyors].contains(model.section) && (model.section == .notes || model.canManage) }
    private var taskOpen: Bool { !["done", "failed", "cancelled", "wrapping_up"].contains(record?.status ?? "") }
    private var deletable: Bool { model.section == .notes || (model.canManage && [.skills, .subAgents, .commands, .conveyors, .planners, .agents].contains(model.section)) || (model.section == .members && model.isOwner) }

    /// The FAB: the one action a record is usually opened for.
    private func primaryAction(_ record: CustomerRecord) -> MobileFAB? {
        if taskSection { return MobileFAB(title: "Reply", icon: "message-square", identifier: "reply-task", disabled: model.busy) { reply() } }
        if model.section == .notes { return MobileFAB(title: "Add comment", icon: "message-square", identifier: "add-comment", disabled: model.busy) { comment() } }
        if editable, !record.flag("is_default") { return MobileFAB(title: "Edit", icon: "pencil", identifier: "edit-record", disabled: model.busy) { edit(record) } }
        if model.section == .agents, model.canManage { return MobileFAB(title: "Edit role", icon: "pencil", identifier: "edit-record", disabled: model.busy) { editRole(record) } }
        return nil
    }
    private func hasSecondaryActions(_ record: CustomerRecord) -> Bool {
        taskSection || model.section == .notes || model.section == .planners || deletable
            || (model.canManage && [.conveyors, .planners, .agents].contains(model.section))
    }
    /// Everything else, in the `…` menu: neutral actions first, destructive last.
    @ViewBuilder private func secondaryActions(_ record: CustomerRecord) -> some View {
        if taskSection {
            Section {
                Button { forward() } label: { MobileMenuLabel("Forward to agent", icon: "send") }
                Button { Task { await loadLogs() } } label: { MobileMenuLabel("Logs", icon: "scroll-text") }
                if !record.text("session_id").isEmpty { Button { terminalPresented = true } label: { MobileMenuLabel("Terminal", icon: "square-terminal") } }
            }
            Section {
                Button { Task { await run(.grade(task: id, 1)) } } label: { MobileMenuLabel("Mark helpful", icon: "thumbs-up") }
                Button { Task { await run(.grade(task: id, 0)) } } label: { MobileMenuLabel("Mark unhelpful", icon: "thumbs-down") }
            }
            Section {
                if taskOpen {
                    Button { ask("Close task") } label: { MobileMenuLabel("Close task", icon: "circle-check") }
                    Button(role: .destructive) { ask("Cancel task") } label: { MobileMenuLabel("Cancel task", icon: "circle-x") }
                }
                Button(role: .destructive) { ask("Delete item") } label: { MobileMenuLabel("Delete task", icon: "trash-2") }
            }
        } else {
            Section {
                if model.section == .notes {
                    if !record.flag("is_default") { Button { edit(record) } label: { MobileMenuLabel("Edit", icon: "pencil") } }
                    Button { noteTask(.convert) } label: { MobileMenuLabel("Send to Inbox", icon: "inbox") }
                    Button { noteTask(.critique) } label: { MobileMenuLabel("Ask for critique", icon: "sparkles") }
                    Button { Task { await run(.archiveNote(project: model.projectID, note: id, restore: model.archived)) } } label: { MobileMenuLabel(model.archived ? "Restore note" : "Archive note", icon: "folder") }
                }
                if model.section == .planners {
                    Button { Task { await run(.plannerVerdict(project: model.projectID, planner: id, 1)) } } label: { MobileMenuLabel("Approve planner", icon: "thumbs-up") }
                    Button { Task { await run(.plannerVerdict(project: model.projectID, planner: id, 0)) } } label: { MobileMenuLabel("Reject planner", icon: "thumbs-down") }
                }
                if model.canManage, [.conveyors, .planners, .agents].contains(model.section) {
                    Button { Task { await run(.setPaused(model.section, project: model.projectID, id: id, paused: !record.flag("paused"))) } } label: {
                        MobileMenuLabel(record.flag("paused") ? "Resume" : "Pause", icon: record.flag("paused") ? "play" : "square")
                    }
                }
            }
            Section {
                if model.section == .agents, model.canManage { Button(role: .destructive) { ask("Reset agent") } label: { MobileMenuLabel("Reset agent", icon: "refresh-cw") } }
                if deletable, !record.flag("is_default") || model.section == .notes || model.section == .members {
                    Button(role: .destructive) { ask("Delete item") } label: { MobileMenuLabel("Delete", icon: "trash-2") }
                }
            }
        }
    }
    private func editRole(_ record: CustomerRecord) {
        editor = MobileEditorRequest(title: "Edit agent role", fields: [.init("role", "Role", .multiline, initial: .string(record.text("role")))]) { body, _ in
            guard await model.perform(.update(.agents, project: model.projectID, id: id, values: body)) != nil else { return false }; await model.refresh(); await refresh(); return true
        }
    }
    /// Skill and command bodies start with YAML front matter that the detail
    /// already shows as fields; Markdown would render it as a stray rule and heading.
    static func withoutFrontMatter(_ text: String) -> String {
        guard text.hasPrefix("---\n"), let end = text.range(of: "\n---", range: text.index(text.startIndex, offsetBy: 4)..<text.endIndex) else { return text }
        return String(text[end.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
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

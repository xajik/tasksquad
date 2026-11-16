import TaskSquadPortalUI
import SwiftUI
import TaskSquadPortal

struct MobileRecordDetail: View {
    @ObservedObject var model: WorkspaceStore
    @ObservedObject var actions: MobileActions
    let id: String
    var isActive = true
    var openTask: (String) -> Void = { _ in }
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var detailStore = RecordDetailStore()
    private var detail: CustomerRecord? { detailStore.detail }
    private var messages: [CustomerRecord] { model.section == .notes ? detailStore.comments : detailStore.messages }
    private var related: [CustomerRecord] { detailStore.related }
    @State private var error: String?
    @State private var sentRevision = 0
    @State private var transcript: String?
    private var record: CustomerRecord? { detail ?? model.records.first { $0.id == id } }
    private var taskSection: Bool { [.inbox, .supervisor].contains(model.section) }
    private var live: Bool { PortalLifecycle.isLive(record?.status ?? "") }
    private var available: [RecordAction] { record.map(model.actions(for:)) ?? [] }
    var body: some View {
        Group {
            if model.section == .portals, let record { portal(record) }
            else { recordList }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if model.section != .portals {
                VStack(spacing: 0) {
                    if let error = actions.error ?? error ?? model.error {
                        TSQErrorBanner(error, identifier: "detail-error").fixedSize(horizontal: false, vertical: true).padding(.horizontal).padding(.vertical, 8).frame(maxWidth: .infinity).background(.bar)
                    }
                    if taskSection, record != nil {
                        permissionBar
                        replyComposer
                    }
                }
            }
        }
        .navigationTitle(model.section == .portals ? model.agentName(record?.text("agent_id") ?? "") : model.section.title)
        .navigationBarTitleDisplayMode(.inline)
        // A record is a focused task: the reply field and terminal get the tab bar's space.
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let record {
                    if let edit = available.first(where: { $0.kind == .edit }) {
                        Button(edit.title) { actions.perform(edit, on: record) }.disabled(model.busy).accessibilityIdentifier("edit-record")
                    }
                    // A live Portal's terminal fills the screen, so its one action stays in the bar.
                    if let close = available.first(where: { $0.kind == .closePortal }) {
                        Button("Close") { actions.perform(close, on: record) }.accessibilityIdentifier("close-portal").disabled(model.busy)
                    } else if available.contains(where: { $0.kind != .edit }) {
                        MobileMoreMenu { MobileActionMenu(actions: actions, record: record, excluding: [.edit]) }
                    }
                }
            }
        }
        .task(id: "\(model.context):\(id):\(phase):\(isActive)") {
            guard phase == .active, isActive else { return }
            actions.refreshDetail = { await refresh() }
            // The shell polls only the visible route; this polls the open record.
            await model.poll(refreshWorkspace: false) { await refresh() }
        }
        .sheet(isPresented: Binding(get: { transcript != nil }, set: { if !$0 { transcript = nil } })) {
            NavigationStack {
                ScrollView { Text(transcript ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled).padding() }
                    .navigationTitle("Transcript").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { transcript = nil } } }
            }
        }
        .sensoryFeedback(.success, trigger: sentRevision)
    }
    private var recordList: some View {
        ScrollViewReader { scroll in
            List {
                if let record {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(model.displayTitle(record)).font(.title2.bold()).textSelection(.enabled)
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 12) { recordMetadata(record) }
                                VStack(alignment: .leading, spacing: 8) { recordMetadata(record) }
                            }
                        }.padding(.vertical, 4).listRowSeparator(.hidden)
                    }
                    if taskSection { conversation }
                    else { contents(record) }
                    if !related.isEmpty {
                        Section("Related tasks") {
                            ForEach(related) { task in
                                Button { openTask(task.id) } label: {
                                    HStack { Text(task.title).foregroundStyle(.primary); Spacer(); if !task.status.isEmpty { TSQBadge(status: task.status) } }
                                }.accessibilityHint("Opens the task")
                            }
                        }
                    }
                } else { HStack { Spacer(); ProgressView("Loading…"); Spacer() }.listRowSeparator(.hidden) }
            }
            .listStyle(.plain)
            .frame(maxWidth: 720).frame(maxWidth: .infinity)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await refresh() }
            .onChange(of: sentRevision) { _, _ in
                guard let last = messages.last else { return }
                if reduceMotion { scroll.scrollTo(last.id, anchor: .bottom) } else { withAnimation { scroll.scrollTo(last.id, anchor: .bottom) } }
            }
        }
    }
    /// A pending permission request, pinned above the reply field so it cannot scroll away.
    @ViewBuilder private var permissionBar: some View {
        if let request = messages.last(where: { $0.text("type") == "permission_request" && $0.text("interaction_status") == "pending" }) {
            let options = permissionOptions(request)
            if !options.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Label("Permission requested", systemImage: "exclamationmark.shield").font(.subheadline.weight(.semibold)).foregroundStyle(MobileTheme.amber)
                    ViewThatFits(in: .horizontal) {
                        HStack { permissionButtons(options) }
                        VStack(alignment: .leading) { permissionButtons(options) }
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 10).frame(maxWidth: 720, alignment: .leading).frame(maxWidth: .infinity)
                .background(.bar).overlay(alignment: .top) { Divider() }
                .accessibilityIdentifier("permission-bar")
            }
        }
    }
    private func permissionButtons(_ options: [String]) -> some View {
        ForEach(options, id: \.self) { option in
            Button(option) { Task { await run(.answerPermission(task: id, option: option)) } }.buttonStyle(.bordered).disabled(model.busy)
        }
    }
    private var replyComposer: some View {
        let context = model.context
        return MobileReplyComposer(model: model, taskID: id) { body, files in
            guard context == model.context else { return "The project changed. Your draft is retained." }
            guard await model.perform(.reply(task: id, values: body, files: files)) != nil else {
                let message = model.error ?? "The reply could not be sent. Your draft is retained."
                model.error = nil // The composer owns this request's error.
                return message
            }
            await refresh()
            sentRevision += 1
            return nil
        }.id(model.context + ":" + id)
    }
    @ViewBuilder private func recordMetadata(_ record: CustomerRecord) -> some View {
        if !record.status.isEmpty { TSQBadge(status: record.status).accessibilityIdentifier("record-status") }
        if record.flag("paused") { TSQBadge("Paused", variant: .warning) }
        if !record.text("agent_id").isEmpty {
            Text(model.agentName(record.text("agent_id"))).font(.subheadline).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func portal(_ record: CustomerRecord) -> some View {
        VStack(spacing: 0) {
            let lifecycle = PortalLifecycle(record)
            if let session = lifecycle.sessionID {
                PortalTerminalScreen(sessionID: session, api: model.api).id(session)
            } else {
                TSQEmptyState(icon: "monitor", title: lifecycle.title, message: lifecycle.message)
                TSQBadge(status: record.status).accessibilityIdentifier("portal-status")
            }
            if let error = actions.error ?? error ?? model.error { TSQErrorBanner(error, identifier: "detail-error").padding() }
        }
    }
    private func author(_ message: CustomerRecord) -> String {
        switch message.text("role") {
        case "user": message.text("sender_id") == model.profile?.id ? "You" : "User"
        case "agent": record.map { model.agentName($0.text("agent_id")) } ?? "Agent"
        default: message.text("role").capitalized
        }
    }
    private var conversation: some View {
        Section("Conversation") {
            ForEach(messages) { message in
                let kind = message.text("type")
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text(author(message)).font(.subheadline.weight(.semibold))
                        if !kind.isEmpty, !["message", "final"].contains(kind) { Text(StatusPresentation(kind).label).font(.caption).foregroundStyle(.secondary) }
                        Spacer()
                        Text(message.date, format: .dateTime.hour().minute()).font(.caption).foregroundStyle(.secondary)
                    }
                    if ["tool_call", "tool_result"].contains(kind) {
                        DisclosureGroup(kind == "tool_call" ? "Tool call" : "Tool result") {
                            Text(message.text("body")).font(.system(.footnote, design: .monospaced)).foregroundStyle(.secondary)
                                .textSelection(.enabled).accessibilityIdentifier("message-" + message.id)
                        }
                    } else {
                        MarkdownContent(message.text("body"), copy: { UIPasteboard.general.string = $0 }).accessibilityIdentifier("message-" + message.id)
                    }
                    if message.number("scheduled_at") > Date().timeIntervalSince1970*1000 { Label("Scheduled reply", systemImage: "clock").font(.caption).foregroundStyle(MobileTheme.warning) }
                    if message.text("interaction_status") == "resolved" {
                        Label("Response: " + message.text("interaction_response"), systemImage: "checkmark.circle").font(.caption).foregroundStyle(MobileTheme.green)
                    }
                    ForEach(message.records("attachments")) { attachment in MobileAttachment(api: model.api, path: ["tasks", id, "messages", message.id, "attachments", attachment.id], name: attachment.text("filename")) }
                }
                .padding(.vertical, 6).id(message.id)
                .listRowBackground(message.text("role") == "user" ? MobileTheme.tint.opacity(0.08) : nil)
                .contextMenu {
                    Button("Copy Message", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text("body") }
                    if !message.text("transcript_key").isEmpty { Button("View Transcript", systemImage: "text.alignleft") { loadTranscript(message) } }
                    if message.text("role") == "agent" {
                        let grade = message.value["grade"]?.number
                        Button("Mark Helpful", systemImage: grade == 1 ? "hand.thumbsup.fill" : "hand.thumbsup") { Task { await run(.gradeMessage(task: id, message: message.id, grade == 1 ? nil : 1)) } }
                        Button("Mark Unhelpful", systemImage: grade == 0 ? "hand.thumbsdown.fill" : "hand.thumbsdown") { Task { await run(.gradeMessage(task: id, message: message.id, grade == 0 ? nil : 0)) } }
                    }
                }
            }
        }
    }
    private func loadTranscript(_ message: CustomerRecord) {
        Task {
            do { transcript = String(decoding: try await model.api.data(["tasks", id, "messages", message.id, "transcript"]), as: UTF8.self) }
            catch { self.error = error.localizedDescription }
        }
    }
    @ViewBuilder private func contents(_ record: CustomerRecord) -> some View {
        ForEach(["description", "content", "body", "role", "category", "frequency", "timezone", "email"], id: \.self) { key in
            if !record.text(key).isEmpty {
                if model.section == .notes, key == "content" {
                    Section { MarkdownContent(record.text(key), copy: { UIPasteboard.general.string = $0 }) }
                } else { Section(key.capitalized) { MarkdownContent(Self.withoutFrontMatter(record.text(key)), copy: { UIPasteboard.general.string = $0 }) } }
            }
        }
        if model.section == .agents {
            Section("Availability") {
                Label(record.flag("paused") ? "Paused" : "Not paused", systemImage: record.flag("paused") ? "pause.circle" : "checkmark.circle")
                if record.number("last_seen") > 0 { Text("Last seen " + Date(timeIntervalSince1970: record.number("last_seen")/1000).formatted(.relative(presentation: .named))) }
            }
        }
        if model.section == .planners {
            Section("Phases") {
                ForEach(record.records("phases")) { phase in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack { Text(phase.title).font(.body.weight(.medium)); Spacer(); if !phase.status.isEmpty { TSQBadge(status: phase.status) } }
                        if !phase.text("last_response").isEmpty { Text(phase.text("last_response")).font(.callout).foregroundStyle(.secondary) }
                    }
                }
            }
        }
        if model.section == .notes {
            Section("Comments") {
                if messages.isEmpty { Text("No comments yet").foregroundStyle(.secondary) }
                ForEach(messages) { Text($0.text("content")) }
                Button("Add comment", systemImage: "plus.bubble") { comment() }.accessibilityIdentifier("add-comment")
            }
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
    private func comment() {
        actions.editor = MobileEditorRequest(title: "Add comment", fields: [.init("content", "Comment", .multiline, required: true)]) { body, _ in
            guard await model.perform(.comment(project: model.projectID, note: id, content: body["content"]?.string ?? "")) != nil else { return false }; await refresh(); return true
        }
    }
}

private struct MobileAttachment: View {
    let api: CustomerAPI
    let path: [String]
    let name: String
    @State private var image: UIImage?
    @State private var error: String?
    @State private var preview = false
    var body: some View {
        VStack(alignment: .leading) {
            if let image {
                Button { preview = true } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 250).clipShape(RoundedRectangle(cornerRadius: MobileTheme.radius))
                }.buttonStyle(.plain).accessibilityLabel(name).accessibilityHint("Opens the image full screen").accessibilityAddTraits(.isImage)
                .fullScreenCover(isPresented: $preview) { MobileImagePreview(image: image, name: name) }
            } else { Label(name, systemImage: "photo") }
            if let error { Text(error).font(.caption).foregroundStyle(MobileTheme.destructive) }
        }.task { do { image = UIImage(data: try await api.data(path)) } catch { self.error = error.localizedDescription } }
    }
}

/// A received image full screen, with pinch to zoom and the share sheet.
private struct MobileImagePreview: View {
    let image: UIImage
    let name: String
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    var body: some View {
        NavigationStack {
            Image(uiImage: image).resizable().scaledToFit().scaleEffect(scale)
                .gesture(MagnifyGesture().onChanged { scale = max(1, min($0.magnification, 5)) }.onEnded { _ in withAnimation { scale = max(1, min(scale, 5)) } })
                .onTapGesture(count: 2) { withAnimation { scale = scale > 1 ? 1 : 2 } }
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.black).ignoresSafeArea(edges: .bottom)
                .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { ShareLink(item: Image(uiImage: image), preview: SharePreview(name, image: Image(uiImage: image))) }
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                }
        }
    }
}

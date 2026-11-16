import AppKit
import SwiftUI
import TaskSquadCore
import TaskSquadPortal
import TaskSquadDesign
import TaskSquadPortalUI
import UniformTypeIdentifiers

struct CustomerTaskDetail: View {
    @ObservedObject var model: CustomerWorkspaceModel
    @ObservedObject var ui: WorkspaceUI
    let record: CustomerRecord
    var supervisorOnly = false
    @State private var reply = ""
    @State private var files: [CustomerUpload] = []
    @State private var scheduled = false
    @State private var scheduledDate = Date().addingTimeInterval(3600)
    @State private var follow = true
    @State private var sending = false
    @State private var supervisorPort = "7374"
    @State private var dropTargeted = false
    @FocusState private var replyFocused: Bool
    private var shownMessages: [CustomerRecord] { supervisorOnly ? model.messages.filter { $0.text("role") == "supervisor" } : model.messages }
    private var replyDraft: WorkspaceDraftScope { model.workspace.draftScope("reply." + record.id) }
    private var active: Bool { !["done", "failed"].contains(record.status) }
    private var pendingReply: CustomerRecord? {
        model.messages.first { $0.text("role") == "user" && $0.number("scheduled_at") > Date().timeIntervalSince1970 * 1000 && $0.text("sender_id") == model.profile?.id }
    }
    private var permissionOptions: [String] {
        guard let request = model.messages.last(where: { $0.text("type") == "permission_request" && $0.text("interaction_status") == "pending" }),
              let data = request.text("json_payload").data(using: .utf8),
              let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [] }
        return json["options"]?.array?.compactMap(\.string) ?? []
    }
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if supervisorOnly { supervisorControls }
                        if !record.text("session_id").isEmpty, active {
                            DisclosureGroup(record.flag("tui_blocked") ? "Live Terminal · agent is waiting for input" : "Live Terminal", isExpanded: $ui.terminalVisible) {
                                if ui.terminalVisible {
                                    CustomerRemoteTerminal(api: try? model.api(), sessionID: record.text("session_id")).frame(height: 360)
                                        .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
                                }
                            }
                        }
                        ForEach(shownMessages) { message in messageView(message) }
                        if shownMessages.isEmpty {
                            Text(supervisorOnly ? "No supervisor reports yet." : "No messages yet.").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.top, 40)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(20).frame(maxWidth: 860).frame(maxWidth: .infinity)
                }.onChange(of: shownMessages.count) { if follow { reader.scrollTo("bottom", anchor: .bottom) } }
            }
            if let pendingReply {
                Divider()
                HStack {
                    Label("Your reply is scheduled for " + Date(timeIntervalSince1970: pendingReply.number("scheduled_at") / 1000).formatted(date: .abbreviated, time: .shortened), systemImage: "clock")
                    Spacer()
                    Button("Edit…") { editMessage(pendingReply) }
                    Button("Cancel Reply…") { deleteMessage(pendingReply) }
                }.padding(12)
            } else if !supervisorOnly { Divider(); composer }
        }
        .onChange(of: ui.replyFocus) { replyFocused = true }
    }
    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(record.title).font(Theme.title).textSelection(.enabled)
            HStack(spacing: 8) {
                CustomerStatus(status: record.status)
                Label(model.agentName(record.text("agent_id")), icon: .bot).labelStyle(TSQLabelStyle(spacing: 4)).font(Theme.callout).foregroundStyle(.secondary)
                Spacer()
                Toggle("Follow Latest", isOn: $follow).toggleStyle(.checkbox).help("Scroll to new messages as they arrive")
            }
            if record.number("scheduled_at") > Date().timeIntervalSince1970 * 1000 {
                Label("Scheduled: " + Date(timeIntervalSince1970: record.number("scheduled_at") / 1000).formatted(date: .abbreviated, time: .shortened), systemImage: "clock")
                    .font(Theme.callout).foregroundStyle(.secondary)
            }
            if record.status == "wrapping_up", !record.strings("close_steps").isEmpty {
                let current = Int(record.number("close_steps_active_idx"))
                ForEach(Array(record.strings("close_steps").enumerated()), id: \.offset) { index, step in
                    Label(step, systemImage: index < current ? "checkmark.circle.fill" : index == current ? "arrow.triangle.2.circlepath" : "circle").font(Theme.callout)
                }
            }
        }.padding(.horizontal, 20).padding(.vertical, 14).frame(maxWidth: .infinity, alignment: .leading)
    }
    private var supervisorControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { Task { await triggerSupervisor() } } label: { Label("Run Supervisor Locally", systemImage: "play") }.disabled(!active || model.busy)
            Text("Manual runs need a local daemon managing this task. Reports from any machine appear below.").font(Theme.caption).foregroundStyle(.secondary)
            DisclosureGroup("Advanced") {
                LabeledContent("Local hooks port") { TextField("Port", text: $supervisorPort).textFieldStyle(.roundedBorder).frame(width: 100).labelsHidden() }
            }.font(Theme.callout)
        }
    }
    private func messageView(_ message: CustomerRecord) -> some View {
        let isUser = message.text("role") == "user"
        let name = isUser ? (message.text("sender_id") == model.profile?.id ? "You" : "User")
            : message.text("role") == "agent" ? model.agentName(record.text("agent_id")) : message.text("role").capitalized
        let task = record.id
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Icon(isUser ? .user : message.text("role") == "agent" ? .bot : .info, size: 14)
                    .foregroundStyle(isUser ? Theme.tint : .secondary)
                    .frame(width: 26, height: 26).background(isUser ? Theme.tint.opacity(0.12) : Theme.muted, in: Circle())
                Text(name.isEmpty ? "Agent" : name).font(Theme.body.weight(.semibold))
                if !message.text("type").isEmpty, !["message", "final"].contains(message.text("type")) {
                    Badge(StatusPresentation(message.text("type")).label, variant: .outline)
                }
                if message.number("scheduled_at") > Date().timeIntervalSince1970 * 1000 {
                    Badge("Scheduled · " + Date(timeIntervalSince1970: message.number("scheduled_at") / 1000).formatted(date: .abbreviated, time: .shortened), variant: .warning)
                }
                Spacer()
                Text(message.date.formatted(date: .abbreviated, time: .shortened)).font(Theme.caption).foregroundStyle(.secondary)
                Button { copyText(message.text("body")) } label: { Image(systemName: "doc.on.doc") }.help("Copy message").accessibilityLabel("Copy message")
                if message.text("role") == "agent" {
                    gradeIcon("hand.thumbsup", label: "Mark helpful", record: message, grade: 1) { .gradeMessage(task: task, message: message.id, $0) }
                    gradeIcon("hand.thumbsdown", label: "Mark unhelpful", record: message, grade: 0) { .gradeMessage(task: task, message: message.id, $0) }
                }
            }.buttonStyle(.borderless)
            if message.text("type") == "thinking" || message.text("type") == "tool_use" {
                DisclosureGroup("Details") { CustomerMarkdown(text: message.text("body")) }.font(Theme.callout)
            } else { CustomerMarkdown(text: message.text("body")) }
            if message.text("interaction_status") == "resolved" {
                Label("Response: " + message.text("interaction_response"), systemImage: "checkmark.circle").font(Theme.callout).foregroundStyle(Theme.green)
            }
            ForEach(message.records("attachments")) { attachment in
                CustomerAttachment(api: try? model.api(), taskID: record.id, messageID: message.id, attachment: attachment)
            }
        }
        .padding(14)
        .background(isUser ? AnyShapeStyle(Theme.tint.opacity(0.08)) : AnyShapeStyle(Theme.card), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.border))
        .contextMenu { messageActions(message) }
        .accessibilityElement(children: .contain)
    }
    /// Selecting the current grade again clears it.
    private func gradeIcon(_ symbol: String, label: String, record: CustomerRecord, grade: Double, operation: @escaping (Double?) -> WorkspaceOperation) -> some View {
        let selected = record.value["grade"]?.number == grade
        return Button { Task { await model.run(operation(selected ? nil : grade)) } } label: {
            Image(systemName: selected ? symbol + ".fill" : symbol).foregroundStyle(selected ? (grade == 1 ? Theme.green : Theme.red) : .secondary)
        }
        .help(label).accessibilityLabel(label).accessibilityAddTraits(selected ? .isSelected : []).disabled(model.busy)
    }
    @ViewBuilder private func messageActions(_ message: CustomerRecord) -> some View {
        Button("Copy Message") { copyText(message.text("body")) }
        if !message.text("transcript_key").isEmpty {
            Button("View Transcript") {
                let path = ["tasks", record.id, "messages", message.id, "transcript"]
                Task {
                    do {
                        let data = try await model.api().data(path)
                        ui.presentedText = CustomerText(title: "Transcript", text: String(decoding: data, as: UTF8.self))
                    } catch { model.error = error.localizedDescription }
                }
            }
        }
        if message.text("role") == "user", message.text("sender_id") == model.profile?.id,
           message.number("scheduled_at") > Date().timeIntervalSince1970 * 1000 {
            Button("Edit Scheduled Reply…") { editMessage(message) }
            Button("Delete Scheduled Reply…", role: .destructive) { deleteMessage(message) }
        }
    }
    private func editMessage(_ message: CustomerRecord) {
        let task = record.id
        ui.editor = CustomerEditorRequest(title: "Edit Scheduled Reply", fields: [.init("body", "Message", .multiline, required: true, initial: .string(message.text("body"))), .init("scheduled_at", "Schedule reply", .date, initial: message.value["scheduled_at"] ?? .null)]) { body, _ in
            guard await model.perform(.editMessage(task: task, message: message.id, values: body)) != nil else { return false }
            await model.refresh(); return true
        }
    }
    private func deleteMessage(_ message: CustomerRecord) {
        let operation = WorkspaceOperation.deleteMessage(task: record.id, message: message.id)
        ui.confirmation = CustomerConfirmation(title: "Cancel scheduled reply?", message: "This message will not be sent.", action: "Delete Reply") { await model.run(operation) }
    }
    /// Shown above the reply field so a pending request cannot scroll out of view.
    @ViewBuilder private var permissionBar: some View {
        if !permissionOptions.isEmpty {
            HStack(spacing: 8) {
                Label("Permission requested", systemImage: "exclamationmark.shield").font(Theme.body.weight(.semibold)).foregroundStyle(Theme.amber)
                Spacer()
                ForEach(permissionOptions, id: \.self) { option in Button(option) { Task { await send(option) } }.disabled(model.busy || sending) }
            }
            .padding(10).background(Theme.amber.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.radius))
            .accessibilityIdentifier("permission-bar")
        }
    }
    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            permissionBar
            TextEditor(text: $reply).font(Theme.body).scrollContentBackground(.hidden).focused($replyFocused)
                .onAppear { reply = model.drafts.load(replyDraft)?["body"]?.string ?? reply }
                .onChange(of: reply) { _, text in if text.isEmpty { model.drafts.remove(replyDraft) } else { model.drafts.save(["body": .string(text)], scope: replyDraft) } }
                .frame(minHeight: 44, maxHeight: 140).fixedSize(horizontal: false, vertical: true)
                .overlay(alignment: .topLeading) {
                    if reply.isEmpty { Text("Reply…").foregroundStyle(.tertiary).padding(.leading, 5).allowsHitTesting(false) }
                }
                .accessibilityLabel("Reply").accessibilityIdentifier("field-body")
            if !files.isEmpty {
                HStack(spacing: 6) {
                    ForEach(files) { file in
                        HStack(spacing: 4) {
                            Image(systemName: "paperclip"); Text(file.name).lineLimit(1)
                            Button { files.removeAll { $0.id == file.id } } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.borderless).accessibilityLabel("Remove " + file.name)
                        }.font(Theme.caption).padding(.horizontal, 8).padding(.vertical, 3).background(Theme.muted, in: Capsule())
                    }
                }
            }
            if scheduled { DatePicker("Send at", selection: $scheduledDate, in: Date()...) }
            HStack(spacing: 10) {
                Button { do { files += try CustomerFiles.chooseImages() } catch { model.error = error.localizedDescription } } label: { Label("Attach Images…", systemImage: "paperclip") }
                    .help("Attach images, or drop them here")
                Toggle(isOn: $scheduled) { Label("Send Later", systemImage: "clock") }.toggleStyle(.button).help("Schedule this reply")
                Spacer()
                Button { Task { await send(reply) } } label: {
                    HStack(spacing: 6) { if sending { ProgressView().controlSize(.mini) }; Text(scheduled ? "Schedule" : "Send") }
                }
                .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command).help("Send (⌘↩)")
                .disabled(sending || model.busy || (reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && files.isEmpty))
                .accessibilityIdentifier("editor-submit")
            }.labelStyle(.iconOnly)
        }
        .padding(12)
        .background(dropTargeted ? AnyShapeStyle(Theme.tint.opacity(0.1)) : AnyShapeStyle(.bar))
        .dropDestination(for: URL.self) { urls, _ in
            do { files += try urls.map(CustomerFiles.upload); return true }
            catch { model.error = error.localizedDescription; return false }
        } isTargeted: { dropTargeted = $0 }
    }
    private func send(_ text: String) async {
        guard !sending else { return }; sending = true; defer { sending = false }
        var body: [String: JSONValue] = ["body": .string(text)]
        if scheduled {
            guard scheduledDate > Date() else { model.error = "Choose a future send time."; return }
            body["scheduled_at"] = .number(scheduledDate.timeIntervalSince1970 * 1000)
        }
        if await model.perform(.reply(task: record.id, values: body, files: files)) != nil {
            reply = ""; files = []; scheduled = false; await model.refresh()
        }
    }
    private func triggerSupervisor() async {
        guard let port = Int(supervisorPort), (1024...65535).contains(port) else { model.error = "Enter a valid local hooks port."; return }
        do {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/hooks/trigger-supervisor")!)
            request.setValue("Bearer " + (try LocalHookAuth.read(port: port)), forHTTPHeaderField: "Authorization")
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(JSONValue.object(["task_id": .string(record.id)]))
            let response = try await NativeHTTPTransport().send(request)
            try response.requireSuccess(); await model.refresh()
        } catch { model.error = "Could not trigger the local supervisor: " + error.localizedDescription }
    }
}

struct CustomerAttachment: View {
    let api: CustomerAPI?
    let taskID: String, messageID: String
    let attachment: CustomerRecord
    @State private var image: NSImage?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let image {
                Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 280).clipShape(RoundedRectangle(cornerRadius: Theme.controlRadius))
                    .accessibilityLabel(attachment.text("filename"))
            }
            Button { Task { await save() } } label: { Label(attachment.text("filename"), systemImage: "arrow.down.circle") }.help("Save attachment…")
            if let error { Text(error).font(Theme.caption).foregroundStyle(Theme.destructive) }
        }.task(id: attachment.id) {
            guard attachment.text("mime_type").hasPrefix("image/"), attachment.number("size") <= 20 * 1024 * 1024, let api else { return }
            do { image = NSImage(data: try await api.data(path)) } catch { self.error = error.localizedDescription }
        }
    }
    private var path: [String] { ["tasks", taskID, "messages", messageID, "attachments", attachment.id] }
    private func save() async {
        guard let api else { return }
        do { try CustomerFiles.save(try await api.data(path), name: attachment.text("filename")) }
        catch { self.error = error.localizedDescription }
    }
}

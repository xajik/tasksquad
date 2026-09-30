import AppKit
import SwiftUI
import TaskSquadCore

struct CustomerTaskDetail: View {
    @ObservedObject var model: CustomerWorkspaceModel
    let record: CustomerRecord
    var supervisorOnly = false
    @Binding var editor: CustomerEditorRequest?
    @Binding var confirmation: CustomerConfirmation?
    @Binding var presentedText: CustomerText?
    @State private var reply = ""
    @State private var files: [CustomerUpload] = []
    @State private var scheduled = false
    @State private var scheduledDate = Date().addingTimeInterval(3600)
    @State private var terminalExpanded = false
    @State private var follow = true
    @State private var sending = false
    @State private var supervisorPort = "7374"
    private var shownMessages: [CustomerRecord] { supervisorOnly ? model.messages.filter { $0.text("role") == "supervisor" } : model.messages }
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
            VStack(alignment: .leading, spacing: 10) {
                Text(record.title).font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.foreground).textSelection(.enabled)
                HStack(spacing: 8) {
                    CustomerStatus(status: record.status)
                    Label(model.agentName(record.text("agent_id")), icon: .bot).labelStyle(TSQLabelStyle(spacing: 4))
                        .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                    Spacer(); Toggle("Follow", isOn: $follow).toggleStyle(.checkbox).font(.system(size: 12))
                    Menu { actions } label: { Text("Actions") }.menuStyle(.button).controlSize(.small).fixedSize()
                }
                if record.number("scheduled_at") > Date().timeIntervalSince1970 * 1000 {
                    Label("Scheduled: " + Date(timeIntervalSince1970: record.number("scheduled_at") / 1000).formatted(), icon: .clock)
                        .labelStyle(TSQLabelStyle(spacing: 4)).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                }
                if record.status == "wrapping_up", !record.strings("close_steps").isEmpty {
                    ForEach(Array(record.strings("close_steps").enumerated()), id: \.offset) { index, step in
                        Label(step, icon: index < Int(record.number("close_steps_active_idx")) ? .circleCheck : index == Int(record.number("close_steps_active_idx")) ? .refreshCw : .circle).labelStyle(TSQLabelStyle(spacing: 6)).font(.system(size: 12))
                    }
                }
            }.padding(.horizontal, 20).padding(.vertical, 16).edgeBorder(.bottom)
            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if supervisorOnly {
                            HStack {
                                TextField("Local hooks port", text: $supervisorPort).textFieldStyle(.roundedBorder).frame(width: 100)
                                Button { Task { await triggerSupervisor() } } label: { Label("Run Supervisor Locally", icon: .play) }.buttonStyle(.tsqOutline).disabled(!active || model.busy)
                            }
                            Text("Manual runs require a local daemon managing this task. Reports from any machine appear below.").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                        }
                        if !record.text("session_id").isEmpty, active {
                            DisclosureGroup(record.flag("tui_blocked") ? "Terminal · agent is waiting for input" : "Live Terminal", isExpanded: $terminalExpanded) {
                                if terminalExpanded {
                                    CustomerRemoteTerminal(api: try? model.api(), sessionID: record.text("session_id")).frame(height: 400)
                                }
                            }
                        }
                        ForEach(shownMessages) { message in messageView(message) }
                        if shownMessages.isEmpty { Text(supervisorOnly ? "No supervisor reports yet." : "No messages yet.").font(.system(size: 13)).foregroundStyle(Theme.mutedForeground) }
                        Color.clear.frame(height: 1).id("bottom")
                    }.padding(20)
                }.background(Theme.muted.opacity(0.25)).onChange(of: shownMessages.count) { _ in if follow { reader.scrollTo("bottom", anchor: .bottom) } }
            }
            if let pendingReply {
                HStack {
                    Label("Your reply is scheduled for " + Date(timeIntervalSince1970: pendingReply.number("scheduled_at") / 1000).formatted(), icon: .clock)
                        .labelStyle(TSQLabelStyle(spacing: 6)).font(.system(size: 13))
                    Spacer()
                    Button("Edit") { editMessage(pendingReply) }.buttonStyle(.tsqOutline)
                    Button("Cancel Reply") { deleteMessage(pendingReply) }.buttonStyle(.tsq(.ghost))
                }.padding(16).edgeBorder(.top)
            } else if !supervisorOnly { composer }
        }
    }
    /// Web `MessageBubble`: bordered card, header row with avatar, name, time, and icon actions.
    private func messageView(_ message: CustomerRecord) -> some View {
        let isUser = message.text("role") == "user"
        let name = isUser ? (message.text("sender_id") == model.profile?.id ? "You" : "User")
            : message.text("role") == "agent" ? model.agentName(record.text("agent_id")) : message.text("role").capitalized
        let gradePath = ["tasks", record.id, "messages", message.id, "grade"]
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Icon(isUser ? .user : message.text("role") == "agent" ? .bot : .info, size: 14)
                    .foregroundStyle(isUser ? Theme.primary : Theme.mutedForeground)
                    .frame(width: 28, height: 28).background(isUser ? Theme.primary.opacity(0.1) : Theme.muted, in: Circle())
                Text(name.isEmpty ? "Agent" : name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.foreground)
                if !message.text("type").isEmpty, !["message", "final"].contains(message.text("type")) {
                    Badge(message.text("type").replacingOccurrences(of: "_", with: " "), variant: .outline)
                }
                if message.number("scheduled_at") > Date().timeIntervalSince1970 * 1000 {
                    Badge("Scheduled · " + Date(timeIntervalSince1970: message.number("scheduled_at") / 1000).formatted(date: .abbreviated, time: .shortened), variant: .warning)
                }
                Spacer()
                Text(message.date.formatted(date: .abbreviated, time: .shortened)).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                Button { copyText(message.text("body")) } label: { Icon(.copy, size: 14) }.buttonStyle(.plain).foregroundStyle(Theme.mutedForeground).help("Copy message")
                if message.text("role") == "agent" {
                    gradeIcon(.thumbsUp, record: message, grade: 1, path: gradePath)
                    gradeIcon(.thumbsDown, record: message, grade: 0, path: gradePath)
                }
                Menu { messageActions(message) } label: { Icon(.ellipsis, size: 14) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().foregroundStyle(Theme.mutedForeground)
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .overlay(alignment: .bottom) { Rectangle().fill(isUser ? Theme.primary.opacity(0.1) : Theme.border.opacity(0.7)).frame(height: 1) }
            VStack(alignment: .leading, spacing: 12) {
                if message.text("type") == "thinking" || message.text("type") == "tool_use" {
                    DisclosureGroup("Details") { CustomerMarkdown(text: message.text("body")) }.font(.system(size: 12))
                } else { CustomerMarkdown(text: message.text("body")) }
                if message.text("interaction_status") == "resolved" { Label("Response: " + message.text("interaction_response"), icon: .circleCheck).labelStyle(TSQLabelStyle(spacing: 6)).font(.system(size: 12)).foregroundStyle(Theme.green) }
                ForEach(message.records("attachments")) { attachment in
                    CustomerAttachment(api: try? model.api(), taskID: record.id, messageID: message.id, attachment: attachment)
                }
            }.padding(16)
        }
        .background(isUser ? Theme.primary.opacity(0.04) : Theme.background, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(isUser ? Theme.primary.opacity(0.2) : Theme.border))
    }
    private func gradeIcon(_ icon: LucideIcon, record: CustomerRecord, grade: Double, path: [String]) -> some View {
        let selected = record.value["grade"]?.number == grade
        return Button {
            Task { await model.perform(path, method: "PATCH", body: ["grade": selected ? .null : .number(grade)]) }
        } label: {
            Icon(icon, size: 14).padding(3)
                .background(selected ? (grade == 1 ? Theme.green : Theme.red).opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: 4))
        }
        .buttonStyle(.plain).foregroundStyle(selected ? (grade == 1 ? Theme.green : Theme.red) : Theme.mutedForeground)
        .help(grade == 1 ? "Good" : "Not helpful").disabled(model.busy)
    }
    @ViewBuilder private var actions: some View {
        Button("Forward to Agent…") {
            let path = ["tasks", record.id, "forward"]
            editor = CustomerEditorRequest(title: "Forward Task", fields: [.init("agent_id", "Agent", .agent, required: true), .init("instructions", "Instructions", .multiline)], submitLabel: "Forward") { body, _ in
                guard let response = await model.mutate(path, body: body) else { return false }
                if let id = response["task_id"]?.string { model.openTask(id) }; return true
            }
        }
        Button("Token Saving…") {
            let settings = record.value["settings"]?["save_tokens"]
            let path = ["tasks", record.id, "settings"]
            editor = CustomerEditorRequest(title: "Token Saving", fields: [.init("enabled", "Enabled", .bool, initial: settings?["enabled"] ?? .bool(false)), .init("level", "Level", .choice(["lite", "full", "ultra"]), initial: settings?["level"] ?? .string("full"))]) { body, _ in
                guard await model.mutate(path, method: "PATCH", body: ["save_tokens": .object(body)]) != nil else { return false }
                await model.refresh(); return true
            }
        }
        Button("View Logs") {
            let id = record.id
            Task {
                do {
                    let logs = CustomerRecord(try await model.api().request(["tasks", id, "logs"])).records("logs")
                    presentedText = CustomerText(title: "Task Logs", text: logs.map { "[\($0.text("level"))] \($0.text("body"))" }.joined(separator: "\n"))
                } catch { model.error = error.localizedDescription }
            }
        }
        Divider()
        gradeButton("Approve Task", record: record, grade: 1, path: ["tasks", record.id, "grade"])
        gradeButton("Reject Task", record: record, grade: 0, path: ["tasks", record.id, "grade"])
        if active {
            Button("Close Task…") {
                let id = record.id
                confirmation = CustomerConfirmation(title: "Close this task?", message: "The agent will finish and close its session.", action: "Close Task") { await model.perform(["tasks", id, "close"]) }
            }
        }
        Button("Delete Task…", role: .destructive) {
            let id = record.id
            confirmation = CustomerConfirmation(title: "Delete this task?", message: "The task and all its messages will be removed permanently.", action: "Delete") {
                if await model.mutate(["tasks", id], method: "DELETE") != nil { model.selectedID = nil; await model.refresh() }
            }
        }
    }
    @ViewBuilder private func messageActions(_ message: CustomerRecord) -> some View {
        Button("Copy") { copyText(message.text("body")) }
        if !message.text("transcript_key").isEmpty {
            Button("View Transcript") {
                let path = ["tasks", record.id, "messages", message.id, "transcript"]
                Task {
                    do {
                        let data = try await model.api().data(path)
                        presentedText = CustomerText(title: "Transcript", text: String(decoding: data, as: UTF8.self))
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
        let path = ["tasks", record.id, "messages", message.id]
        editor = CustomerEditorRequest(title: "Edit Scheduled Reply", fields: [.init("body", "Message", .multiline, required: true, initial: .string(message.text("body"))), .init("scheduled_at", "Schedule reply", .date, initial: message.value["scheduled_at"] ?? .null)]) { body, _ in
            guard await model.mutate(path, method: "PUT", body: body) != nil else { return false }
            await model.refresh(); return true
        }
    }
    private func deleteMessage(_ message: CustomerRecord) {
        let path = ["tasks", record.id, "messages", message.id]
        confirmation = CustomerConfirmation(title: "Cancel scheduled reply?", message: "This message will not be sent.", action: "Delete Reply") { await model.perform(path, method: "DELETE") }
    }
    private func gradeButton(_ title: String, record: CustomerRecord, grade: Double, path: [String]) -> some View {
        Button((record.value["grade"]?.number == grade ? "✓ " : "") + title) {
            Task { await model.perform(path, method: "PATCH", body: ["grade": record.value["grade"]?.number == grade ? .null : .number(grade)]) }
        }.disabled(model.busy)
    }
    /// Web reply box: bordered card, borderless text area, footer with Schedule and Send.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !permissionOptions.isEmpty {
                HStack(spacing: 8) {
                    Label("Permission requested", icon: .shieldAlert).labelStyle(TSQLabelStyle(spacing: 6)).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.amber)
                    ForEach(permissionOptions, id: \.self) { option in Button(option) { Task { await send(option) } }.buttonStyle(.tsqOutline).disabled(model.busy || sending) }
                }
            }
            VStack(spacing: 0) {
                TextEditor(text: $reply).font(.system(size: 13)).scrollContentBackground(.hidden)
                    .frame(minHeight: 64, maxHeight: 120).padding(.horizontal, 10).padding(.top, 8)
                    .overlay(alignment: .topLeading) {
                        if reply.isEmpty { Text("Write your reply…").font(.system(size: 13)).foregroundStyle(Theme.mutedForeground).padding(.horizontal, 15).padding(.top, 8).allowsHitTesting(false) }
                    }
                if !files.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(files) { file in
                            HStack(spacing: 4) {
                                Icon(.paperclip, size: 12); Text(file.name).lineLimit(1)
                                Button { files.removeAll { $0.id == file.id } } label: { Icon(.x, size: 12) }.buttonStyle(.plain)
                            }.font(.system(size: 12)).padding(.horizontal, 8).padding(.vertical, 3).background(Theme.muted, in: RoundedRectangle(cornerRadius: 4))
                        }
                        Spacer()
                    }.padding(.horizontal, 12).padding(.bottom, 8)
                }
                if scheduled {
                    HStack { DatePicker("Send at", selection: $scheduledDate).font(.system(size: 12)); Spacer() }.padding(.horizontal, 12).padding(.vertical, 8).edgeBorder(.top)
                }
                HStack(spacing: 6) {
                    Button { do { files += try CustomerFiles.chooseImages() } catch { model.error = error.localizedDescription } } label: { Label("Attach", icon: .paperclip) }
                        .buttonStyle(.tsq(.ghost)).foregroundStyle(Theme.mutedForeground)
                    Button { scheduled.toggle() } label: { Label(scheduled ? "Cancel schedule" : "Schedule", icon: .clock) }
                        .buttonStyle(.tsq(.ghost)).foregroundStyle(Theme.mutedForeground)
                    Spacer()
                    Text("⌘↩ to send").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                    Button { Task { await send(reply) } } label: {
                        HStack(spacing: 6) { if sending { ProgressView().controlSize(.mini) }; Text(scheduled ? "Schedule" : "Send") }
                    }
                    .buttonStyle(.tsq(.default)).keyboardShortcut(.return, modifiers: .command)
                    .disabled(sending || model.busy || (reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && files.isEmpty))
                }.padding(.horizontal, 10).padding(.vertical, 8).background(Theme.muted.opacity(0.3)).edgeBorder(.top)
            }
            .background(Theme.background, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.border))
        }.padding(16).edgeBorder(.top)
    }
    private func send(_ text: String) async {
        guard !sending else { return }; sending = true; defer { sending = false }
        var body: [String: JSONValue] = ["body": .string(text)]
        if scheduled {
            guard scheduledDate > Date() else { model.error = "Choose a future send time."; return }
            body["scheduled_at"] = .number(scheduledDate.timeIntervalSince1970 * 1000)
        }
        if await model.mutate(["tasks", record.id, "messages"], body: body, files: files) != nil {
            reply = ""; files = []; scheduled = false; await model.refresh()
        }
    }
    private func triggerSupervisor() async {
        guard let port = Int(supervisorPort), (1024...65535).contains(port) else { model.error = "Enter a valid local hooks port."; return }
        do {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/hooks/trigger-supervisor")!)
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
            if let image { Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 280) }
            Button { Task { await save() } } label: { Label(attachment.text("filename"), icon: .download) }.buttonStyle(.tsqOutline)
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.destructive) }
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

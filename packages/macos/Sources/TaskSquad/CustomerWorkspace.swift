import AppKit
import SwiftUI
import TaskSquadCore

struct CustomerWorkspace: View {
    @ObservedObject var model: CustomerWorkspaceModel
    @State private var editor: CustomerEditorRequest?
    @State private var confirmation: CustomerConfirmation?
    @State private var presentedText: CustomerText?
    @State private var connectionSettings = false

    var body: some View {
        VStack(spacing: 0) {
            if let error = model.error { ErrorBanner(message: error) { model.error = nil } }
            if model.profile == nil { signIn }
            else { workspace }
        }
        .background(Theme.background)
        .sheet(item: $editor) { CustomerEditor(model: model, request: $0) }
        .sheet(item: $presentedText) { value in
            VStack(alignment: .leading, spacing: 16) {
                Text(value.title).font(.system(size: 18, weight: .semibold))
                ScrollView { Text(value.text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(12) }
                    .background(Theme.muted.opacity(0.5), in: RoundedRectangle(cornerRadius: Theme.radius))
                HStack { Button { copyText(value.text) } label: { Label("Copy", icon: .copy) }.buttonStyle(.tsq(.outline, size: .default)); Spacer(); Button("Done") { presentedText = nil }.buttonStyle(.tsqPrimary).keyboardShortcut(.defaultAction) }
            }.padding(24).frame(width: 700, height: 550)
        }
        .sheet(isPresented: $connectionSettings) { connectionSheet }
        .alert(item: $confirmation) { value in
            Alert(title: Text(value.title), message: Text(value.message), primaryButton: .destructive(Text(value.action)) { Task { await value.perform() } }, secondaryButton: .cancel())
        }
        .onChange(of: model.teamID) { _ in editor = nil; confirmation = nil; presentedText = nil }
        .onChange(of: model.profile?.id) { _ in editor = nil; confirmation = nil; presentedText = nil }
        .task(id: "\(model.active):\(model.selectionKey)") {
            guard model.active else { return }
            await model.restore()
            while !Task.isCancelled {
                await model.refresh()
                do { try await Task.sleep(for: .seconds(model.isPro ? 2 : 5)) } catch { return }
            }
        }
    }
    /// Mirrors the web `Login` page: a small centered card.
    private var signIn: some View {
        VStack {
            Card(padding: 24) {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        BrandLogo(size: 32).padding(.bottom, 6)
                        Text("Sign in").font(.system(size: 24, weight: .bold)).foregroundStyle(Theme.foreground)
                        Text("Tasks, notes, and projects — shared with the TaskSquad web app. Local agents are optional.")
                            .font(.system(size: 13)).foregroundStyle(Theme.mutedForeground).fixedSize(horizontal: false, vertical: true)
                    }
                    if model.signingIn {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Complete sign-in in your browser").font(.system(size: 13)).foregroundStyle(Theme.mutedForeground)
                            Spacer()
                            Button("Cancel") { model.cancelLogin() }.buttonStyle(.tsqOutline)
                        }
                    } else {
                        Button { model.signIn() } label: { Label("Continue in browser", icon: .externalLink).frame(maxWidth: .infinity) }
                            .buttonStyle(TSQButtonStyle(variant: .default, size: .default, fullWidth: true)).keyboardShortcut(.defaultAction)
                        if model.loading {
                            HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Restoring your account…").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground) }
                        }
                    }
                    Button("Connection settings") { connectionSettings = true }
                        .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                        .disabled(model.signingIn)
                }
            }.frame(width: 380)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.muted.opacity(0.35))
    }
    private var connectionSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Connection settings").font(.system(size: 18, weight: .semibold))
            Text("Only change these for a self-hosted or development server.").font(.system(size: 13)).foregroundStyle(Theme.mutedForeground)
            TextField("API URL", text: $model.apiURL)
            TextField("Web app URL", text: $model.dashboardURL)
            TextField("Firebase public API key (optional until token refresh)", text: $model.firebaseAPIKey)
            HStack {
                Spacer()
                Button("Cancel") { connectionSettings = false }.buttonStyle(.tsq(.outline, size: .default))
                Button("Save") { Task { await model.saveConnection(); connectionSettings = false } }.buttonStyle(.tsqPrimary).keyboardShortcut(.defaultAction)
            }
        }.textFieldStyle(.roundedBorder).padding(24).frame(width: 460)
    }
    private var workspace: some View {
        VStack(spacing: 0) {
            header
            if model.teamID.isEmpty {
                EmptyState(icon: .folderPlus, title: "Create your first project", message: "Projects group your agents, tasks, and team members.") {
                    Button { editor = .newProject(model: model) } label: { Label("New project", icon: .plus) }.buttonStyle(.tsqPrimary)
                }
            } else if model.section == .settings { settings }
            else if model.section == .analytics { CustomerAnalytics(model: model).edgeBorder(.top) }
            else {
                HSplitView {
                    recordList.frame(minWidth: 260, idealWidth: 320, maxWidth: 440).edgeBorder(.trailing)
                    if let record = model.selected { detail(record).frame(maxWidth: .infinity, maxHeight: .infinity) }
                    else { EmptyState(icon: model.section.icon, title: "Select \(model.section == .inbox ? "a task" : "an item")", message: "Details and actions appear here.") }
                }.edgeBorder(.top)
            }
        }
    }
    private var header: some View {
        PageHeader(title: model.section.isLibrary ? CustomerSection.skills.title : model.section.title, subtitle: model.currentTeam?.title) {
            if model.loading || model.busy { ProgressView().controlSize(.small) }
            if model.section.isLibrary {
                Picker("Library", selection: $model.section) {
                    Text("Skills").tag(CustomerSection.skills); Text("Sub-agents").tag(CustomerSection.subAgents); Text("Commands").tag(CustomerSection.commands)
                }.pickerStyle(.segmented).labelsHidden().frame(width: 260)
            }
            if model.section != .analytics { // Analytics has its own refresh beside its filters.
                Button { Task { await model.connect(); await model.refresh() } } label: { Icon(.refreshCw) }
                    .buttonStyle(.tsqIcon).foregroundStyle(Theme.mutedForeground).help("Refresh")
            }
            Button { model.openInBrowser() } label: { Label("Open in Web", icon: .externalLink) }.buttonStyle(.tsq(.outline, size: .default))
            if canCreate {
                Button { createRecord() } label: { Label(model.section == .inbox ? "New Task" : "New", icon: .plus) }
                    .buttonStyle(.tsqPrimary).disabled(model.busy)
            }
        }
    }
    private var canCreate: Bool {
        guard !model.teamID.isEmpty else { return false }
        switch model.section {
        case .supervisor, .memory, .settings, .analytics: return false
        case .agents: return model.isMaintainer
        case .members: return model.isOwner
        case .portals: return model.isPro
        default: return true
        }
    }
    private var recordList: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                SearchField("Search \(model.section.title.lowercased())", text: $model.search)
                HStack(spacing: 8) {
                    if [.inbox, .supervisor].contains(model.section) {
                        filter("Status", $model.statusFilter, ["all", "pending", "queued", "running", "waiting_input", "wrapping_up", "done", "failed", "scheduled"])
                        if model.section == .inbox {
                            filter("Origin", $model.sourceFilter, ["all", "mine", "system", "from-note", "note-critique", "scheduled", "planner", "conveyor"])
                        }
                    }
                    if model.section == .notes { Toggle("Archived", isOn: $model.archived).toggleStyle(.checkbox).font(.system(size: 12)) }
                    if model.section == .memory {
                        filter("Category", $model.memoryCategory, ["all", "personal", "preferences", "structure", "architecture", "events"])
                        Picker("Rollups", selection: $model.rollupPeriod) { Text("Daily").tag("daily"); Text("Weekly").tag("weekly") }
                            .pickerStyle(.segmented).labelsHidden().frame(width: 130)
                    }
                    Spacer(minLength: 0)
                }
                if model.section == .memory { SearchField("Filter by tag", text: $model.memoryTag) }
                if model.section == .portals, !model.isPro {
                    Text("Portals require Pro. Existing portal details remain available.").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                }
            }.padding(12)
            TSQList(items: model.visibleRecords, selection: $model.selectedID) { record in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(record.title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(2)
                        Spacer(minLength: 4)
                        if record.number("created_at") > 0 {
                            Text(Date(timeIntervalSince1970: record.number("created_at") / 1000), format: .relative(presentation: .named))
                                .font(.system(size: 11)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        }
                    }
                    HStack(spacing: 6) {
                        if !record.status.isEmpty { Badge(status: record.status) }
                        if record.flag("paused") { Badge("Paused", variant: .warning) }
                        if !record.text("agent_id").isEmpty {
                            Label(model.agentName(record.text("agent_id")), icon: .bot).labelStyle(TSQLabelStyle(spacing: 4)).lineLimit(1)
                        }
                    }.font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                    if model.section == .supervisor { Text("\(Int(record.number("supervisor_report_count"))) findings").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground) }
                    if !record.text("description").isEmpty { Text(record.text("description")).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineLimit(2) }
                    if !record.strings("tags").isEmpty { Text(record.strings("tags").map { "#" + $0 }.joined(separator: " ")).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground) }
                }
            }.overlay {
                if model.visibleRecords.isEmpty, !model.loading {
                    EmptyState(icon: model.section.icon, title: model.search.isEmpty ? "No \(model.section.title.lowercased()) yet" : "No matches",
                               message: model.search.isEmpty ? "New items appear here automatically." : "Try a different search.")
                }
            }
            if model.section == .notes, model.hasMore {
                Button("Load more notes") { Task { await model.refresh(loadMore: true) } }.buttonStyle(.tsqOutline).padding(12)
            }
            if model.section == .memory, !model.rollups.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(model.rollupPeriod.capitalized) rollups").font(.system(size: 13, weight: .semibold))
                        ForEach(model.rollups) { rollup in
                            Button(rollup.title) { presentedText = CustomerText(title: rollup.title, text: rollup.text("content")) }.buttonStyle(.link)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                }.frame(maxHeight: 170).edgeBorder(.top)
            }
        }
    }
    /// Compact filter like the web's `SelectTrigger className="h-7 w-28 text-xs"`.
    private func filter(_ title: String, _ value: Binding<String>, _ options: [String]) -> some View {
        SelectMenu(title: title, selection: value, options: options.map {
            ($0, $0 == "all" ? "Any \(title.lowercased())" : $0.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ").capitalized)
        })
    }
    @ViewBuilder private func detail(_ record: CustomerRecord) -> some View {
        switch model.section {
        case .inbox, .supervisor:
            CustomerTaskDetail(model: model, record: record, supervisorOnly: model.section == .supervisor, editor: $editor, confirmation: $confirmation, presentedText: $presentedText).id(record.id)
        case .notes:
            CustomerNoteDetail(model: model, record: record, edit: { editRecord(record) }, editor: $editor, confirmation: $confirmation).id(record.id)
        case .portals:
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Icon(.monitor).foregroundStyle(Theme.mutedForeground)
                    Text(model.agentName(record.text("agent_id"))).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.foreground)
                    CustomerStatus(status: record.status); Spacer()
                    if ["pending", "running"].contains(record.status) { Button("Close Portal") { confirmClosePortal(record) }.buttonStyle(.tsqOutline) }
                }.padding(.horizontal, 16).padding(.vertical, 12).edgeBorder(.bottom)
                if !record.text("session_id").isEmpty, record.status == "running" {
                    CustomerRemoteTerminal(api: try? model.api(), sessionID: record.text("session_id"))
                } else { EmptyState(icon: .monitor, title: record.status == "pending" ? "Waiting for the agent" : "Portal \(record.status)", message: "The agent's daemon handles this terminal session.") }
            }
        case .planners: plannerDetail(record)
        default: genericDetail(record)
        }
    }
    private func genericDetail(_ record: CustomerRecord) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(record.title).font(.system(size: 24, weight: .bold)).foregroundStyle(Theme.foreground).textSelection(.enabled)
                genericActions(record)
                if !record.status.isEmpty { CustomerStatus(status: record.status) }
                if model.section == .members { LabeledContent("Role", value: record.text("role")) }
                if model.section == .agents {
                    LabeledContent("Agent ID", value: record.id).textSelection(.enabled)
                    Text(record.text("role", fallback: "No role configured")).textSelection(.enabled)
                    if record.flag("reset_pending") { Label("Reset pending", icon: .clock) }
                }
                if model.section == .conveyors {
                    LabeledContent("Agent", value: model.agentName(record.text("agent_id")))
                    LabeledContent("Schedule", value: "\(record.text("frequency").capitalized) · \(Int(record.number("hour"))):\(String(format: "%02d", Int(record.number("minute")))) · \(record.text("timezone"))")
                    LabeledContent("Runs completed", value: String(Int(record.number("repeat_counter"))))
                    if record.number("next_run_at") > 0 { LabeledContent("Next run", value: Date(timeIntervalSince1970: record.number("next_run_at") / 1000).formatted()) }
                    CustomerMarkdown(text: record.text("body"))
                    linkedTasks
                }
                if model.section.isLibrary {
                    Text(record.text("description")).foregroundStyle(Theme.mutedForeground)
                    HStack(spacing: 6) {
                        Badge(record.flag("auto_install") ? "Automatically installed" : "Manual installation", variant: .outline)
                        if record.flag("is_default") { Badge("Built-in · duplicate to customize") }
                    }
                }
                CustomerMarkdown(text: record.text("content"))
                if model.section == .memory {
                    HStack(spacing: 6) {
                        Badge(record.text("category").capitalized, variant: .outline)
                        ForEach(record.strings("tags"), id: \.self) { Badge("#" + $0) }
                    }
                }
            }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    @ViewBuilder private func genericActions(_ record: CustomerRecord) -> some View {
        HStack {
            if model.section.isLibrary {
                Button("Duplicate") { editRecord(record, duplicate: true) }
                if !record.flag("is_default") { Button("Edit") { editRecord(record) }; Button("Delete", role: .destructive) { confirmDelete(record) } }
            }
            if model.section == .conveyors {
                Button("Edit") { editRecord(record) }
                Button("Run Now") {
                    let team = model.teamID
                    Task {
                        if let result = await model.mutate(["tasks"], body: ["team_id": .string(team), "agent_id": .string(record.text("agent_id")), "subject": .string(record.title), "body": .string(record.text("body")), "auto_close": .bool(record.flag("auto_close"))]), let id = result["id"]?.string { model.openTask(id) }
                    }
                }
                Button(record.flag("paused") ? "Resume" : "Pause") { perform(model.path(for: .conveyors, id: record.id), method: "PUT", body: ["paused": .bool(!record.flag("paused"))]) }
                Button("Delete", role: .destructive) { confirmDelete(record) }
            }
            if model.section == .agents, model.isMaintainer {
                Button("Edit Role") { editRecord(record) }
                Button(record.flag("paused") ? "Resume" : "Pause") { perform(model.path(for: .agents, id: record.id) + ["pause"], body: ["paused": .bool(!record.flag("paused"))]) }
                Menu("More") {
                    Button("Create Agent Token") {
                        let path = model.teamPath("tokens"), name = record.title
                        Task {
                            if let result = await model.mutate(path, body: ["agent_id": .string(record.id), "label": .string("Native app")]) {
                                presentedText = CustomerText(title: "Token for \(name) · save it now", text: result["token"]?.string ?? "")
                            }
                        }
                    }
                    Button("Reset Agent") {
                        let path = model.path(for: .agents, id: record.id) + ["reset"]
                        confirmation = CustomerConfirmation(title: "Reset \(record.title)?", message: "This requests a reset of the agent's current session.", action: "Reset") { await model.perform(path) }
                    }
                    Button("Delete Agent", role: .destructive) { confirmDelete(record) }
                }
            }
            if model.section == .members {
                if model.isOwner, record.id != model.profile?.id, record.text("role") != "maintainer" {
                    Button("Remove Member", role: .destructive) { confirmDelete(record) }
                } else if record.id == model.profile?.id, record.text("role") != "owner" {
                    Button("Leave Project", role: .destructive) { leaveProject() }
                }
            }
        }.buttonStyle(.tsqOutline).disabled(model.busy)
    }
    private func plannerDetail(_ record: CustomerRecord) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 10) {
                    Text(record.title).font(.system(size: 24, weight: .bold)).foregroundStyle(Theme.foreground)
                    CustomerStatus(status: record.status)
                }
                Text(record.text("description")).foregroundStyle(Theme.mutedForeground).textSelection(.enabled)
                HStack {
                    Button(record.flag("paused") ? "Resume" : "Pause") { perform(model.path(for: .planners, id: record.id), method: "PATCH", body: ["paused": .bool(!record.flag("paused"))]) }
                    Button("Approve") { perform(model.path(for: .planners, id: record.id), method: "PATCH", body: ["planner_verdict": .number(1)]) }
                    Button("Reject") { perform(model.path(for: .planners, id: record.id), method: "PATCH", body: ["planner_verdict": .number(0)]) }
                    Button("Clear Verdict") { perform(model.path(for: .planners, id: record.id), method: "PATCH", body: ["planner_verdict": .null]) }
                    Button("Delete", role: .destructive) { confirmDelete(record) }
                }.buttonStyle(.tsqOutline).disabled(model.busy)
                if record.value["planner_verdict"] != nil, record.value["planner_verdict"] != .null {
                    Badge(status: record.number("planner_verdict") == 1 ? "approved" : "rejected")
                }
                ForEach(Array(record.records("phases").enumerated()), id: \.offset) { index, phase in
                    Card {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack { Text("\(index + 1). \(phase.title)").font(.system(size: 15, weight: .semibold)); Spacer(); CustomerStatus(status: phase.status) }
                            Text("Retries: \(Int(phase.number("retry_count"))) / \(Int(phase.number("max_retries")))").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                            if !phase.text("task_id").isEmpty { Button("Open Task") { model.openTask(phase.text("task_id")) } }
                            if !phase.text("task_id").isEmpty {
                                HStack {
                                    Button(phase.text("user_verdict") == "approved" ? "✓ Phase Approved" : "Approve Phase") {
                                        perform(["tasks", phase.text("task_id"), "grade"], method: "PATCH", body: ["grade": phase.text("user_verdict") == "approved" ? .null : .number(1)])
                                    }
                                    Button(phase.text("user_verdict") == "rejected" ? "✓ Phase Rejected" : "Reject Phase") {
                                        perform(["tasks", phase.text("task_id"), "grade"], method: "PATCH", body: ["grade": phase.text("user_verdict") == "rejected" ? .null : .number(0)])
                                    }
                                }.disabled(model.busy)
                            }
                            if !phase.text("supervisor_task_id").isEmpty { Button("Open Supervisor Task") { model.openTask(phase.text("supervisor_task_id")) } }
                            if !phase.text("supervisor_verdict").isEmpty { LabeledContent("Supervisor verdict", value: phase.text("supervisor_verdict")) }
                            CustomerMarkdown(text: phase.text("last_response"))
                        }.frame(maxWidth: .infinity, alignment: .leading).buttonStyle(.tsqOutline)
                    }
                }
            }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private var linkedTasks: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Tasks").font(.system(size: 15, weight: .semibold))
            ForEach(model.related) { task in Button(task.title) { model.openTask(task.id) }.buttonStyle(.link) }
        }
    }
    private var settings: some View {
        Form {
            Section("Project") {
                LabeledContent("Name", value: model.currentTeam?.title ?? "")
                LabeledContent("Your role", value: model.currentTeam?.text("role") ?? "")
                if model.isMaintainer {
                    Toggle("Learn from sessions", isOn: Binding(get: { model.currentTeam?.flag("learn_from_session") ?? false }, set: { setTeamSetting("learn_from_session", $0) }))
                    Toggle("Project memory", isOn: Binding(get: { model.currentTeam?.flag("memory_enabled") ?? false }, set: { setTeamSetting("memory_enabled", $0) }))
                }
            }
            Section("Account") {
                LabeledContent("Email", value: model.profile?.text("email") ?? "")
                LabeledContent("Plan", value: model.isPro ? "Pro" : "Free")
                Button("Plans and Billing") { if let url = URL(string: model.dashboardURL + "/pricing") { NSWorkspace.shared.open(url) } }
                Toggle("Task notifications while the workspace is open", isOn: Binding(get: { model.notifications }, set: { value in Task { await model.setNotifications(value) } }))
                LabeledContent("API", value: model.apiURL)
                Text("Workspace sign-in is independent of the local daemon's sign-in. Signing out here does not stop local agents.").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
            }
            Section("Project access") {
                if model.isOwner {
                    Button("Delete Project…", role: .destructive) {
                        let id = model.teamID, name = model.currentTeam?.title ?? "project"
                        editor = CustomerEditorRequest(title: "Delete \(name)", fields: [.init("confirm", "Type the project name", required: true)], submitLabel: "Delete Project") { body, _ in
                            guard body["confirm"]?.string == name else { model.error = "Project name does not match."; return false }
                            guard await model.mutate(["teams", id], method: "DELETE") != nil else { return false }
                            await model.connect(); return true
                        }
                    }
                } else { Button("Leave Project…", role: .destructive) { leaveProject() } }
            }
        }.formStyle(.grouped).scrollContentBackground(.hidden).frame(maxWidth: 760).frame(maxWidth: .infinity).edgeBorder(.top).disabled(model.busy)
    }
    private func setTeamSetting(_ key: String, _ value: Bool) {
        let path = ["teams", model.teamID]
        Task { if await model.mutate(path, method: "PATCH", body: [key: .bool(value)]) != nil { await model.connect() } }
    }
    private func leaveProject() {
        guard let user = model.profile else { return }
        let path = model.teamPath("members", id: user.id)
        confirmation = CustomerConfirmation(title: "Leave this project?", message: "You will lose access until invited again.", action: "Leave") {
            if await model.mutate(path, method: "DELETE") != nil { await model.connect() }
        }
    }
    private func createRecord() { editRecord(nil) }
    private func editRecord(_ record: CustomerRecord?, duplicate: Bool = false) {
        let section = model.section, team = model.teamID
        let updating = record != nil && !duplicate
        let path = model.path(for: section, id: updating ? record?.id : nil)
        var fields = CustomerField.fields(for: section, record: record)
        if section == .agents, updating { fields.removeAll { $0.id != "role" } }
        if duplicate, let index = fields.firstIndex(where: { $0.id == "name" }) { fields[index].initial = .string((record?.title ?? "") + "-copy") }
        editor = CustomerEditorRequest(title: "\(updating ? "Edit" : "New") \(section.rawValue)", fields: fields, attachments: section == .inbox, phases: section == .planners, submitLabel: updating ? "Save" : "Create") { values, files in
            var body = values
            if [.inbox, .portals].contains(section) { body["team_id"] = .string(team) }
            if section == .inbox {
                body["save_tokens"] = .object(["enabled": body.removeValue(forKey: "save_tokens_enabled") ?? .bool(false), "level": body.removeValue(forKey: "save_tokens_level") ?? .string("full")])
                if body["scheduled_at"] == .null { body.removeValue(forKey: "scheduled_at") }
                if body["close_steps"] == .array([]) { body.removeValue(forKey: "close_steps") }
            }
            if section == .conveyors {
                guard (0...23).contains(Int(body["hour"]?.number ?? -1)), (0...59).contains(Int(body["minute"]?.number ?? -1)), TimeZone(identifier: body["timezone"]?.string ?? "") != nil else {
                    model.error = "Enter a valid hour, minute, and time zone."; return false
                }
                if body["frequency"] == .string("weekly"), !(0...6).contains(Int(body["day_of_week"]?.number ?? -1)) { model.error = "Choose a weekday from 0 to 6."; return false }
                if body["frequency"] == .string("monthly"), !(1...31).contains(Int(body["day_of_month"]?.number ?? -1)) { model.error = "Choose a day from 1 to 31."; return false }
                if let count = body["repeat_count"]?.number, count < 1 { model.error = "Maximum runs must be positive."; return false }
            }
            let method = updating ? (section == .agents ? "PATCH" : "PUT") : "POST"
            guard let result = await model.mutate(path, method: method, body: body, files: files) else { return false }
            if let id = result["id"]?.string { model.selectedID = id }
            await model.refresh(); return true
        }
    }
    private func confirmDelete(_ record: CustomerRecord) {
        let path = model.path(for: model.section, id: record.id)
        confirmation = CustomerConfirmation(title: "Delete \(record.title)?", message: "This cannot be undone.", action: "Delete") {
            if await model.mutate(path, method: "DELETE") != nil { model.selectedID = nil; await model.refresh() }
        }
    }
    private func confirmClosePortal(_ record: CustomerRecord) {
        confirmation = CustomerConfirmation(title: "Close this portal?", message: "The remote terminal session will end.", action: "Close Portal") {
            await model.perform(["portals", record.id, "close"])
        }
    }
    private func perform(_ path: [String], method: String = "POST", body: [String: JSONValue] = [:]) {
        Task { await model.perform(path, method: method, body: body) }
    }
}

struct CustomerConfirmation: Identifiable {
    let id = UUID()
    let title: String, message: String, action: String
    let perform: @MainActor () async -> Void
}
struct CustomerText: Identifiable { let id = UUID(); let title: String, text: String }

struct CustomerStatus: View {
    let status: String
    var body: some View { Badge(status: status) }
}
struct CustomerMarkdown: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(MarkdownBlock.parse(text)) { MarkdownBlockView(block: $0) }
        }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
}

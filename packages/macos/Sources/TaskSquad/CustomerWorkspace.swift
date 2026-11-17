import AppKit
import SwiftUI
import TaskSquadCore
import TaskSquadPortal
import TaskSquadDesign
import TaskSquadPortalUI

/// The middle column: the current section's records as a system list, with
/// search, filters and "New" in the toolbar.
struct CustomerRecordList: View {
    @ObservedObject var model: CustomerWorkspaceModel
    @ObservedObject var ui: WorkspaceUI

    var body: some View {
        List(selection: $model.selectedID) {
            if model.section == .portals, !model.isPro {
                Text("Portals require Pro. Existing portal details remain available.").font(Theme.callout).foregroundStyle(.secondary)
            }
            ForEach(model.visibleRecords) { record in
                CustomerRecordRow(model: model, record: record).tag(record.id)
                    .accessibilityIdentifier("record-" + record.id)
            }
            if model.section == .notes, model.hasMore {
                Button("Load More Notes") { Task { await model.refresh(loadMore: true) } }.buttonStyle(.link)
            }
            if model.section == .memory, !model.rollups.isEmpty {
                Section(model.rollupPeriod.capitalized + " Rollups") {
                    ForEach(model.rollups) { rollup in
                        Button(rollup.title) { ui.presentedText = CustomerText(title: rollup.title, text: rollup.text("content")) }.buttonStyle(.link)
                    }
                }
            }
        }
        .listStyle(.inset)
        .contextMenu(forSelectionType: String.self) { ids in
            if let record = model.visibleRecords.first(where: { ids.contains($0.id) }) {
                RecordActionMenu(ui: ui, record: record)
                Divider()
                Button("Open in Web") { model.selectedID = record.id; model.openInBrowser() }
            }
        }
        .onDeleteCommand {
            guard let record = model.selected, let delete = ui.actions(for: record).first(where: { $0.kind == .delete }) else { return }
            ui.perform(delete, on: record)
        }
        .overlay { if model.visibleRecords.isEmpty { emptyState } }
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.section == .memory {
                TextField("Filter by tag", text: $model.memoryTag).textFieldStyle(.roundedBorder).padding(.horizontal, 12).padding(.vertical, 8)
            }
        }
        .searchable(text: $model.search, isPresented: $ui.searching, placement: .toolbar, prompt: "Search " + model.section.title)
        .navigationTitle(model.section.title)
        .navigationSubtitle(model.currentTeam?.title ?? "")
        .toolbar {
            ToolbarItemGroup {
                if model.section.isLibrary {
                    Picker("Library", selection: $model.section) {
                        ForEach(CustomerSection.libraries) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented).help("Choose skills, sub-agents or commands")
                }
                if hasFilters { filterMenu }
                if ui.canCreate {
                    Button { ui.create() } label: { Label(ui.createTitle, systemImage: "plus") }
                        .help(ui.createTitle + " (⌘N)").disabled(model.busy).accessibilityIdentifier("create-item")
                }
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        if model.loading { ProgressView().controlSize(.small) }
        else if !model.search.isEmpty { ContentUnavailableView.search(text: model.search) }
        else if filtered {
            ContentUnavailableView {
                Label("No Matching Results", systemImage: "line.3.horizontal.decrease.circle")
            } description: { Text("No \(plural) match the current filters.") } actions: {
                Button("Clear Filters") { clearFilters() }
            }
        } else {
            EmptyState(icon: model.section.icon, title: "No \(plural.capitalized) Yet",
                       message: ui.canCreate ? "Create a \(model.section.itemName) to get started." : "They appear here when they are available.") {
                if ui.canCreate { Button(ui.createTitle) { ui.create() } }
            }
        }
    }
    private var plural: String { model.section == .inbox || model.section == .supervisor ? "tasks" : model.section.rawValue.lowercased() }
    private var hasFilters: Bool { [.inbox, .supervisor, .notes, .memory].contains(model.section) }
    private var filtered: Bool {
        model.statusFilter != "all" || model.sourceFilter != "all" || (model.section == .notes && model.archived)
            || (model.section == .memory && (model.memoryCategory != "all" || !model.memoryTag.isEmpty))
    }
    private func clearFilters() {
        model.statusFilter = "all"; model.sourceFilter = "all"; model.memoryTag = ""
        if model.archived { model.archived = false }
        if model.memoryCategory != "all" { model.memoryCategory = "all" }
    }
    private var filterMenu: some View {
        Menu {
            if [.inbox, .supervisor].contains(model.section) {
                Picker("Status", selection: $model.statusFilter) {
                    ForEach(WorkspaceFilter.statuses, id: \.self) { Text(WorkspaceFilter.label($0, any: "Any Status")).tag($0) }
                }
                if model.section == .inbox {
                    Picker("Origin", selection: $model.sourceFilter) {
                        ForEach(WorkspaceFilter.origins, id: \.self) { Text(WorkspaceFilter.label($0, any: "Any Origin")).tag($0) }
                    }
                }
            }
            if model.section == .notes { Toggle("Show Archived Notes", isOn: $model.archived) }
            if model.section == .memory {
                Picker("Category", selection: $model.memoryCategory) {
                    ForEach(WorkspaceFilter.memoryCategories, id: \.self) { Text(WorkspaceFilter.label($0, any: "Any Category")).tag($0) }
                }
                Picker("Rollups", selection: $model.rollupPeriod) { Text("Daily").tag("daily"); Text("Weekly").tag("weekly") }
            }
            if filtered { Divider(); Button("Clear Filters") { clearFilters() } }
        } label: {
            Label(filtered ? "Filter (active)" : "Filter", systemImage: filtered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .help(filtered ? "Filters are active" : "Filter this list")
        .accessibilityIdentifier("view-options")
    }
}

struct CustomerRecordRow: View {
    @ObservedObject var model: CustomerWorkspaceModel
    let record: CustomerRecord
    var body: some View {
        let agent = model.agentName(record.text("agent_id"))
        TSQRecordRow(title: model.section == .portals ? agent : record.title, status: record.status, paused: record.flag("paused"),
                     detail: model.section == .supervisor ? "\(Int(record.number("supervisor_report_count"))) findings"
                        : record.text("agent_id").isEmpty || model.section == .portals ? nil : agent,
                     summary: record.text("description"), tags: record.strings("tags"),
                     date: record.number("created_at") > 0 ? record.date : nil)
    }
}

/// The trailing column: the selected record, with its actions in the toolbar.
struct CustomerDetail: View {
    @ObservedObject var model: CustomerWorkspaceModel
    @ObservedObject var ui: WorkspaceUI

    var body: some View {
        Group {
            if let record = model.selected { detail(record) }
            else {
                ContentUnavailableView {
                    Label { Text("No \(model.section.itemName.capitalized) Selected") } icon: { Icon(model.section.icon, size: 40) }
                } description: { Text("Select one from the list to see its details and actions.") }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The toolbar never changes shape with the selection: the same buttons are
        // always there and are disabled when they do not apply. Buttons that come
        // and go move their neighbours and make the whole bar jump on every click.
        .toolbar {
            ToolbarItemGroup {
                ForEach(slots, id: \.self) { kind in
                    let action = available.first { $0.kind == kind }
                    let info = Self.slotInfo[kind] ?? (kind.rawValue.capitalized, "circle")
                    Button {
                        if let record = model.selected, let action { ui.perform(action, on: record) }
                    } label: {
                        Label(info.title, systemImage: (action?.isOn ?? false) ? info.image + ".fill" : info.image)
                    }
                    .disabled(action == nil || model.busy).help(info.title).accessibilityIdentifier("action-" + kind.rawValue)
                }
            }
            ToolbarItem {
                Menu {
                    if let record = model.selected {
                        ForEach(available.filter { !slots.contains($0.kind) && $0.placement != .destructive }) { RecordActionButton(ui: ui, record: record, action: $0) }
                        Divider()
                        Button { model.openInBrowser() } label: { Label("Open in Web", systemImage: "safari") }
                        Divider()
                        ForEach(available.filter { !slots.contains($0.kind) && $0.placement == .destructive }) { RecordActionButton(ui: ui, record: record, action: $0) }
                    }
                } label: { Label("More Actions", systemImage: "ellipsis.circle") }
                .disabled(model.selected == nil).help("More actions").accessibilityIdentifier("more-actions")
            }
        }
    }
    private var available: [RecordAction] { model.selected.map(ui.actions(for:)) ?? [] }
    /// The buttons this section shows in the toolbar, in a fixed order.
    private var slots: [RecordAction.Kind] {
        switch model.section {
        case .inbox, .supervisor: [.forward, .close]
        case .notes, .skills, .subAgents, .commands, .agents: [.edit]
        case .portals: [.closePortal]
        case .conveyors: [.edit, .runNow]
        case .planners: [.approve, .reject]
        default: []
        }
    }
    private static let slotInfo: [RecordAction.Kind: (title: String, image: String)] = [
        .forward: ("Forward to Agent…", "arrowshape.turn.up.right"), .close: ("Close Task", "checkmark.circle"),
        .edit: ("Edit", "pencil"), .runNow: ("Run Now", "play.circle"), .closePortal: ("Close Portal", "xmark.circle"),
        .approve: ("Approve", "hand.thumbsup"), .reject: ("Reject", "hand.thumbsdown"),
    ]

    @ViewBuilder private func detail(_ record: CustomerRecord) -> some View {
        switch model.section {
        case .inbox, .supervisor:
            CustomerTaskDetail(model: model, ui: ui, record: record, supervisorOnly: model.section == .supervisor).id(record.id)
        case .notes:
            CustomerNoteDetail(model: model, ui: ui, record: record).id(record.id)
        case .portals:
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Text(model.agentName(record.text("agent_id"))).font(Theme.headline)
                    CustomerStatus(status: record.status); Spacer()
                }.padding(.horizontal, 16).padding(.vertical, 10)
                Divider()
                let lifecycle = PortalLifecycle(record)
                if let session = lifecycle.sessionID {
                    CustomerRemoteTerminal(api: try? model.api(), sessionID: session)
                } else { EmptyState(icon: .monitor, title: lifecycle.title, message: lifecycle.message) }
            }
        case .planners: plannerDetail(record)
        default: genericDetail(record)
        }
    }
    private func genericDetail(_ record: CustomerRecord) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(record.title).font(Theme.title).textSelection(.enabled)
                if !record.status.isEmpty { CustomerStatus(status: record.status) }
                if model.section == .members { LabeledContent("Role", value: record.text("role").capitalized) }
                if model.section == .agents {
                    LabeledContent("Agent ID", value: record.id).textSelection(.enabled)
                    Text(record.text("role", fallback: "No role configured")).textSelection(.enabled)
                    if record.flag("paused") { Label("Paused", systemImage: "pause.circle").foregroundStyle(Theme.amber) }
                    if record.flag("reset_pending") { Label("Reset pending", systemImage: "clock") }
                }
                if model.section == .conveyors {
                    LabeledContent("Agent", value: model.agentName(record.text("agent_id")))
                    LabeledContent("Schedule", value: "\(record.text("frequency").capitalized) · \(Int(record.number("hour"))):\(String(format: "%02d", Int(record.number("minute")))) · \(record.text("timezone"))")
                    LabeledContent("Runs completed", value: String(Int(record.number("repeat_counter"))))
                    if record.number("next_run_at") > 0 { LabeledContent("Next run", value: Date(timeIntervalSince1970: record.number("next_run_at") / 1000).formatted(date: .abbreviated, time: .shortened)) }
                    CustomerMarkdown(text: record.text("body"))
                    if !model.related.isEmpty { linkedTasks }
                }
                if model.section.isLibrary {
                    Text(record.text("description")).foregroundStyle(.secondary)
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
            }.padding(24).frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func plannerDetail(_ record: CustomerRecord) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(spacing: 10) {
                    Text(record.title).font(Theme.title)
                    CustomerStatus(status: record.status)
                }
                Text(record.text("description")).foregroundStyle(.secondary).textSelection(.enabled)
                if record.value["planner_verdict"] != nil, record.value["planner_verdict"] != .null {
                    Badge(status: record.number("planner_verdict") == 1 ? "approved" : "rejected")
                }
                ForEach(Array(record.records("phases").enumerated()), id: \.offset) { index, phase in
                    Card {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack { Text("\(index + 1). \(phase.title)").font(Theme.headline); Spacer(); CustomerStatus(status: phase.status) }
                            Text("Retries: \(Int(phase.number("retry_count"))) / \(Int(phase.number("max_retries")))").font(Theme.caption).foregroundStyle(.secondary)
                            if !phase.text("task_id").isEmpty { Button("Open Task") { model.openTask(phase.text("task_id")) } }
                            if !phase.text("task_id").isEmpty {
                                HStack {
                                    Button(phase.text("user_verdict") == "approved" ? "Phase Approved" : "Approve Phase") {
                                        run(.grade(task: phase.text("task_id"), phase.text("user_verdict") == "approved" ? nil : 1))
                                    }
                                    Button(phase.text("user_verdict") == "rejected" ? "Phase Rejected" : "Reject Phase") {
                                        run(.grade(task: phase.text("task_id"), phase.text("user_verdict") == "rejected" ? nil : 0))
                                    }
                                }.disabled(model.busy)
                            }
                            if !phase.text("supervisor_task_id").isEmpty { Button("Open Supervisor Task") { model.openTask(phase.text("supervisor_task_id")) } }
                            if !phase.text("supervisor_verdict").isEmpty { LabeledContent("Supervisor verdict", value: phase.text("supervisor_verdict")) }
                            CustomerMarkdown(text: phase.text("last_response"))
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }.padding(24).frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private var linkedTasks: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Tasks").font(Theme.headline)
            ForEach(model.related) { task in
                HStack { Button(task.title) { model.openTask(task.id) }.buttonStyle(.link); CustomerStatus(status: task.status) }
            }
        }
    }
    private func run(_ operation: WorkspaceOperation) { Task { await model.run(operation) } }
}

/// Shown instead of the workspace until someone signs in.
struct CustomerSignIn: View {
    @ObservedObject var model: CustomerWorkspaceModel
    @State private var connectionSettings = false
    var body: some View {
        VStack(spacing: 16) {
            BrandLogo(size: 56)
            Text("Sign in to TaskSquad").font(Theme.largeTitle)
            Text("Tasks, notes and projects, shared with the TaskSquad web app. Local agents are optional.")
                .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 380)
            if model.signingIn {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Complete sign-in in your browser").foregroundStyle(.secondary) }
                Button("Cancel") { model.cancelLogin() }
            } else {
                Button { model.signIn() } label: { Text("Continue in Browser").frame(minWidth: 200) }
                    .buttonStyle(.borderedProminent).controlSize(.large).keyboardShortcut(.defaultAction)
                if model.loading {
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Restoring your account…").font(Theme.callout).foregroundStyle(.secondary) }
                }
            }
            Button("Connection Settings…") { connectionSettings = true }.buttonStyle(.link).disabled(model.signingIn)
        }
        .padding(40).frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $connectionSettings) {
            VStack(alignment: .leading, spacing: 0) {
                CustomerConnectionForm(model: model)
                HStack {
                    Spacer()
                    Button("Cancel") { connectionSettings = false }.keyboardShortcut(.cancelAction)
                    Button("Save") { Task { await model.saveConnection(); connectionSettings = false } }.keyboardShortcut(.defaultAction)
                }.padding(16)
            }.frame(width: 480)
        }
    }
}

/// Server addresses; only editable while signed out.
struct CustomerConnectionForm: View {
    @ObservedObject var model: CustomerWorkspaceModel
    var body: some View {
        Form {
            Section {
                TextField("API URL", text: $model.apiURL)
                TextField("Web app URL", text: $model.dashboardURL)
                TextField("Firebase API key", text: $model.firebaseAPIKey, prompt: Text("Optional until token refresh"))
            } footer: {
                Text(model.profile == nil ? "Only change these for a self-hosted or development server." : "Sign out to change the server.")
            }
        }.formStyle(.grouped).disabled(model.profile != nil || model.signingIn)
    }
}

/// Full-width pages (no record list): project settings and the first-project prompt.
struct CustomerProjectPage: View {
    @ObservedObject var model: CustomerWorkspaceModel
    @ObservedObject var ui: WorkspaceUI
    var body: some View {
        Group {
            if model.teamID.isEmpty {
                EmptyState(icon: .folderPlus, title: "Create Your First Project", message: "Projects group your agents, tasks and team members.") {
                    Button("New Project…") { ui.newProject() }.buttonStyle(.borderedProminent)
                }
            } else if model.section == .analytics { CustomerAnalytics(model: model) }
            else { settings }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(model.teamID.isEmpty ? "TaskSquad" : model.section.title)
        .navigationSubtitle(model.currentTeam?.title ?? "")
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
            Section("Project access") {
                if model.isOwner {
                    Button("Delete Project…", role: .destructive) {
                        let id = model.teamID, name = model.currentTeam?.title ?? "project"
                        ui.editor = CustomerEditorRequest(title: "Delete \(name)", fields: [.init("confirm", "Type the project name", required: true)], submitLabel: "Delete Project") { body, _ in
                            guard body["confirm"]?.string == name else { model.error = "Project name does not match."; return false }
                            guard await model.perform(.deleteProject(id)) != nil else { return false }
                            await model.connect(); return true
                        }
                    }
                } else { Button("Leave Project…", role: .destructive) { leaveProject() } }
            }
        }.formStyle(.grouped).frame(maxWidth: 760).frame(maxWidth: .infinity).disabled(model.busy)
    }
    private func setTeamSetting(_ key: String, _ value: Bool) {
        let operation = WorkspaceOperation.setProjectFlag(project: model.teamID, key: key, value)
        Task { if await model.perform(operation) != nil { await model.connect() } }
    }
    private func leaveProject() {
        guard let user = model.profile else { return }
        let operation = WorkspaceOperation.delete(.members, project: model.teamID, id: user.id)
        ui.confirmation = CustomerConfirmation(title: "Leave this project?", message: "You lose access until you are invited again.", action: "Leave") {
            if await model.perform(operation) != nil { await model.connect() }
        }
    }
}

/// Sheets and confirmation dialogs for the main window.
struct CustomerPresentations: ViewModifier {
    @ObservedObject var model: CustomerWorkspaceModel
    @ObservedObject var ui: WorkspaceUI
    func body(content: Content) -> some View {
        content
            .sheet(item: $ui.editor) { CustomerEditor(model: model, request: $0) }
            .sheet(item: $ui.presentedText) { value in
                VStack(alignment: .leading, spacing: 12) {
                    Text(value.title).font(Theme.headline)
                    ScrollView { Text(value.text).font(Theme.monoSmall).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(12) }
                        .background(Theme.muted, in: RoundedRectangle(cornerRadius: Theme.radius))
                    HStack {
                        Button { copyText(value.text) } label: { Label("Copy", systemImage: "doc.on.doc") }
                        Spacer()
                        Button("Done") { ui.presentedText = nil }.keyboardShortcut(.defaultAction)
                    }
                }.padding(20).frame(minWidth: 520, idealWidth: 700, minHeight: 360, idealHeight: 550)
            }
            .confirmationDialog(ui.confirmation?.title ?? "", isPresented: Binding(get: { ui.confirmation != nil }, set: { if !$0 { ui.confirmation = nil } }), presenting: ui.confirmation) { value in
                Button(value.action, role: value.destructive ? .destructive : nil) { Task { await value.perform() } }
                Button("Cancel", role: .cancel) { }
            } message: { Text($0.message) }
            .onChange(of: model.teamID) { ui.dismissAll() }
            .onChange(of: model.profile?.id) { ui.dismissAll() }
    }
}

struct CustomerStatus: View {
    let status: String
    var body: some View { Badge(status: status) }
}
struct CustomerMarkdown: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(MarkdownBlock.parse(text)) { MarkdownBlockView(block: $0, copy: copyText) }
        }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
}

import TaskSquadPortalUI
import SwiftUI
import Charts
import TaskSquadPortal

struct PortalHomeView: View {
    @AppStorage("mobile.appearance") private var appearance = "system"
    @ObservedObject var auth: MobileAuthStore
    @StateObject private var model: WorkspaceStore
    @State private var selectedID: String?
    @State private var editor: MobileEditorRequest?
    @Environment(\.scenePhase) private var scenePhase

    init(auth: MobileAuthStore, api: CustomerAPI? = nil) {
        self.auth = auth
        _model = StateObject(wrappedValue: WorkspaceStore(api: api ?? CustomerAPI(baseURL: MobileAuthStore.apiURL) { force in try await auth.accessToken(forceRefresh: force) }, preferences: api == nil ? .standard : nil))
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Project", selection: $model.projectID) { ForEach(model.projects) { Text($0.title).tag($0.id) } }.accessibilityIdentifier("project-picker")
                    Picker("Section", selection: $model.section) { ForEach(WorkspaceSection.allCases) { Text($0.rawValue).tag($0) } }.accessibilityIdentifier("section-picker")
                }
                if model.section == .settings { settings }
                else if model.section == .analytics { analytics }
                else {
                    if model.section == .inbox {
                        Section("Filters") {
                            Picker("Status", selection: $model.status) { ForEach(["all", "pending", "running", "waiting_input", "scheduled", "wrapping_up", "done", "failed"], id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) } }.accessibilityIdentifier("status-filter")
                            Picker("Origin", selection: $model.origin) { ForEach(["all", "mine", "system", "scheduled", "planner", "conveyor", "from-note", "note-critique"], id: \.self) { Text($0.capitalized).tag($0) } }
                        }
                    }
                    if model.section == .portals {
                        if !model.isPro { Text("Interactive Portals require an eligible account.").foregroundStyle(MobileTheme.mutedForeground) }
                        else if model.eligibleAgents.isEmpty { Text("No available agents. Bring an agent online to open a Portal.").foregroundStyle(MobileTheme.mutedForeground) }
                        else if model.records.filter({ ["pending", "running"].contains($0.status) }).count >= 3 { Text("Three sessions are active. Close one to open another.").foregroundStyle(MobileTheme.mutedForeground) }
                    }
                    if model.section == .memory {
                        Picker("Category", selection: $model.memoryCategory) { ForEach(["all","personal","preferences","structure","architecture","events"], id: \.self) { Text($0.capitalized).tag($0) } }.onChange(of: model.memoryCategory) { _, _ in Task { await model.refresh() } }
                        if !model.rollups.isEmpty { Section("Daily rollups") { ForEach(model.rollups) { rollup in DisclosureGroup(rollup.title) { MarkdownContent(rollup.text("content")) } } } }
                    }
                    if model.section == .notes { Toggle("Archived notes", isOn: $model.archived).onChange(of: model.archived) { _, _ in Task { await model.refresh() } } }
                    if model.loading { ProgressView("Loading…") }
                    else if model.visibleRecords.isEmpty { ContentUnavailableView("No \(model.section.rawValue.lowercased())", systemImage: "tray", description: Text("Choose another project or create a new item.")) }
                    else if model.section == .portals {
                        portalSection("Active sessions", live: true)
                        portalSection("History", live: false)
                    } else {
                        Section(model.section.rawValue) { ForEach(model.visibleRecords) { record in row(record) } }
                    }
                    if model.hasMore { Button("Load more") { Task { await model.refresh(loadMore: true) } }.disabled(model.loading) }
                    if let refreshedAt = model.refreshedAt { Text("Updated \(refreshedAt.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(MobileTheme.mutedForeground) }
                }

            }
            .safeAreaInset(edge: .bottom) {
                if let error = model.error { Text(error).font(.footnote).foregroundStyle(MobileTheme.destructive).padding().frame(maxWidth: .infinity).background(.regularMaterial).accessibilityIdentifier("workspace-error") }
            }
            .scrollContentBackground(.hidden).background(MobileTheme.background)
            .searchable(text: $model.search, prompt: "Search \(model.section.rawValue)")
            .navigationTitle(model.section.rawValue)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { if canCreate { Button { create() } label: { MobileIcon(name: "plus") }.accessibilityLabel("Create " + model.section.rawValue).accessibilityIdentifier("create-item").disabled(model.busy) } } }
            .refreshable { await model.connect() }
            .task { await model.connect() }
            .onChange(of: model.context) { _, _ in selectedID = nil }
            .task(id: "\(model.context):\(scenePhase)") {
                guard scenePhase == .active else { return }
                await model.poll()
            }
            .sheet(item: $editor) { MobileEditor(model: model, request: $0) }
            .navigationDestination(item: $selectedID) { id in
                MobileRecordDetail(model: model, id: id)
            }
        }
    }
    private var canCreate: Bool { model.canCreate }
    @ViewBuilder private func portalSection(_ title: String, live: Bool) -> some View {
        let values = model.visibleRecords.filter { ["pending", "running"].contains($0.status) == live }
        if !values.isEmpty { Section(title) { ForEach(values) { row($0) } } }
        if live && !model.isPro { Text("Interactive Portals require an eligible account.").foregroundStyle(MobileTheme.mutedForeground) }
    }
    private func row(_ record: CustomerRecord) -> some View {
        Button { selectedID = record.id } label: {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(model.section == .portals ? model.agentName(record.text("agent_id")) : record.title).font(.headline).foregroundStyle(MobileTheme.foreground)
                    if !record.status.isEmpty { TSQBadge(status: record.status) }
                    if model.section == .agents { Text(record.flag("paused") ? "Paused" : "Available").font(.caption).foregroundStyle(MobileTheme.mutedForeground) }
                    if record.number("created_at") > 0 { Text(record.date, style: .relative).font(.caption).foregroundStyle(MobileTheme.mutedForeground) }
                }
                Spacer(); MobileIcon(name: "chevron-right", size: 16).foregroundStyle(.tertiary)
            }.padding(.vertical, 3)
        }.buttonStyle(.plain).accessibilityIdentifier("record-" + record.id)
    }
    private func create() {
        let section = model.section, project = model.projectID, context = model.context
        model.error = nil
        editor = MobileEditorRequest(title: section == .inbox ? "New task" : "New " + section.rawValue.lowercased(), fields: WorkspaceField.fields(for: section), draftKey: model.draftScope("create." + section.rawValue).key, eligibleAgentsOnly: section == .portals, attachments: section == .inbox, phases: section == .planners, submitLabel: section == .inbox ? "Send" : "Create") { body, files in
            guard context == model.context, let result = await model.perform(.create(section, project: project, values: body, files: files)) else { return false }
            await model.refresh()
            let record = CustomerRecord(result)
            selectedID = record.id.isEmpty ? nil : record.id
            return true
        }
    }
    private var settings: some View {
        Section("Account and project") {
            Text(model.profile?.text("email") ?? "")
            Picker("Appearance", selection: $appearance) { Text("System").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") }
            Text("Project role: \(model.currentProject?.text("role") ?? "member")")
            Text("API: \(model.api.baseURL.absoluteString)").font(.caption)
            if model.canManage {
                Toggle("Learn from sessions", isOn: setting("learn_from_session"))
                Toggle("Project memory", isOn: setting("memory_enabled"))
            }
            Button("Sign out", role: .destructive) { Task { await auth.signOut() } }
        }
    }
    private func setting(_ key: String) -> Binding<Bool> { Binding(get: { model.currentProject?.flag(key) ?? false }, set: { value in Task { if await model.perform(.setProjectFlag(project: model.projectID, key: key, value)) != nil { await model.connect() } } }) }
    private var analytics: some View {
        Section("Last 30 days") {
            if let record = model.records.first {
                ForEach(["created", "done", "failed", "in_progress", "scheduled"], id: \.self) { key in
                    LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: String(Int(record.value["totals"]?[key]?.number ?? 0)))
                }
                if !record.records("daily").isEmpty {
                    Chart(record.records("daily").indices, id: \.self) { index in
                        let day = record.records("daily")[index]
                        BarMark(x: .value("Day", day.text("date")), y: .value("Created", day.number("created")))
                    }.frame(height: 180).accessibilityLabel("Tasks created by day")
                }
                ForEach(record.records("agents").indices, id: \.self) { index in
                    let agent = record.records("agents")[index]
                    LabeledContent(agent.title, value: "\(Int(agent.number("done"))) completed / \(Int(agent.number("tasks"))) tasks")
                }
                ForEach(["turns", "input_tokens", "output_tokens", "tool_calls", "tool_errors"], id: \.self) { key in
                    LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: String(Int(record.value["usage"]?[key]?.number ?? 0)))
                }
            }
        }
    }
}

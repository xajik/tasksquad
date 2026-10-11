import SwiftUI
import TaskSquadPortal

struct PortalHomeView: View {
    @ObservedObject var auth: MobileAuthStore
    @StateObject private var model: WorkspaceStore
    @State private var selectedID: String?
    @State private var editor: MobileEditorRequest?
    @Environment(\.scenePhase) private var scenePhase

    init(auth: MobileAuthStore, api: CustomerAPI? = nil) {
        self.auth = auth
        _model = StateObject(wrappedValue: WorkspaceStore(api: api ?? CustomerAPI(baseURL: MobileAuthStore.apiURL) { force in try await auth.accessToken(forceRefresh: force) }))
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
                            Picker("Origin", selection: $model.origin) { ForEach(["all", "mine", "system", "scheduled", "planner", "conveyor", "from-note"], id: \.self) { Text($0.capitalized).tag($0) } }
                        }
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
                    if let refreshedAt = model.refreshedAt { Text("Updated \(refreshedAt.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(.secondary) }
                }
                if let error = model.error { Text(error).foregroundStyle(.red).accessibilityIdentifier("workspace-error") }
            }
            .searchable(text: $model.search, prompt: "Search \(model.section.rawValue)")
            .navigationTitle(model.section.rawValue)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { if canCreate { Button { create() } label: { Image(systemName: "plus") }.accessibilityLabel("Create " + model.section.rawValue).accessibilityIdentifier("create-item").disabled(model.busy) } } }
            .refreshable { await model.connect() }
            .task { await model.connect() }
            .task(id: "\(model.context):\(scenePhase)") {
                selectedID = nil
                guard scenePhase == .active else { return }
                await model.refresh()
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(5)) } catch { return }
                    await model.refresh()
                }
            }
            .sheet(item: $editor) { MobileEditor(model: model, request: $0) }
            .navigationDestination(item: $selectedID) { id in
                MobileRecordDetail(model: model, id: id)
            }
        }
    }
    private var canCreate: Bool {
        if [.inbox, .notes].contains(model.section) { return !model.projectID.isEmpty }
        if model.section == .portals { return model.isPro && !model.eligibleAgents.isEmpty && model.records.filter { ["pending", "running"].contains($0.status) }.count < 3 }
        if model.section == .members { return model.isOwner }
        return model.canManage && ![.supervisor, .memory, .analytics, .settings].contains(model.section)
    }
    @ViewBuilder private func portalSection(_ title: String, live: Bool) -> some View {
        let values = model.visibleRecords.filter { ["pending", "running"].contains($0.status) == live }
        if !values.isEmpty { Section(title) { ForEach(values) { row($0) } } }
        if live && !model.isPro { Text("Interactive Portals require an eligible account.").foregroundStyle(.secondary) }
    }
    private func row(_ record: CustomerRecord) -> some View {
        Button { selectedID = record.id } label: {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(model.section == .portals ? model.agentName(record.text("agent_id")) : record.title).font(.headline).foregroundStyle(.primary)
                    if !record.status.isEmpty { Text(record.status.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption).foregroundStyle(record.status == "waiting_input" ? .orange : .secondary) }
                    if model.section == .agents { Text(record.flag("paused") ? "Paused" : "Available").font(.caption).foregroundStyle(.secondary) }
                    if record.number("created_at") > 0 { Text(record.date, style: .relative).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer(); Image(systemName: "chevron.right").foregroundStyle(.tertiary)
            }.padding(.vertical, 3)
        }.buttonStyle(.plain).accessibilityIdentifier("record-" + record.id)
    }
    private func create() {
        let section = model.section, project = model.projectID, context = model.context
        model.error = nil
        editor = MobileEditorRequest(title: section == .inbox ? "New task" : "New " + section.rawValue.lowercased(), fields: WorkspaceField.fields(for: section), draftKey: "\(model.profile?.id ?? "").\(project).\(section.rawValue)", attachments: section == .inbox, phases: section == .planners, submitLabel: section == .inbox ? "Send" : "Create") { body, files in
            var body = body
            if [.inbox, .portals].contains(section) { body["team_id"] = .string(project) }
            if section == .inbox {
                body["save_tokens"] = .object(["enabled": body.removeValue(forKey: "save_tokens_enabled") ?? .bool(false), "level": body.removeValue(forKey: "save_tokens_level") ?? .string("full")])
            }
            guard context == model.context, let result = await model.mutate(model.path(section, project: project), body: body, files: files) else { return false }
            await model.refresh()
            let record = CustomerRecord(result)
            selectedID = record.id.isEmpty ? nil : record.id
            return true
        }
    }
    private var settings: some View {
        Section("Account and project") {
            Text(model.profile?.text("email") ?? "")
            Text("Project role: \(model.currentProject?.text("role") ?? "member")")
            Text("API: \(model.api.baseURL.absoluteString)").font(.caption)
            if model.canManage {
                Toggle("Learn from sessions", isOn: setting("learn_from_session"))
                Toggle("Project memory", isOn: setting("memory_enabled"))
            }
            Button("Sign out", role: .destructive) { Task { await auth.signOut() } }
        }
    }
    private func setting(_ key: String) -> Binding<Bool> { Binding(get: { model.currentProject?.flag(key) ?? false }, set: { value in Task { if await model.mutate(["teams", model.projectID], method: "PATCH", body: [key: .bool(value)]) != nil { await model.connect() } } }) }
    private var analytics: some View {
        Section("Last 30 days") {
            if let record = model.records.first {
                ForEach(["created", "done", "failed", "in_progress", "scheduled"], id: \.self) { key in
                    LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: String(Int(record.value["totals"]?[key]?.number ?? 0)))
                }
                ForEach(["turns", "input_tokens", "output_tokens", "tool_calls", "tool_errors"], id: \.self) { key in
                    LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: String(Int(record.value["usage"]?[key]?.number ?? 0)))
                }
            }
        }
    }
}

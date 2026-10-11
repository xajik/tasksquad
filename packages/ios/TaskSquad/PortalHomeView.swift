import TaskSquadPortalUI
import SwiftUI
import Charts
import TaskSquadPortal

struct PortalHomeView: View {
    @ObservedObject var auth: MobileAuthStore
    @StateObject private var model: WorkspaceStore
    @State private var navigation = MobileNavigation()
    @State private var filtersPresented = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AccessibilityFocusState private var menuFocused: Bool
    @State private var editor: MobileEditorRequest?
    @Environment(\.scenePhase) private var scenePhase

    init(auth: MobileAuthStore, api: CustomerAPI? = nil) {
        self.auth = auth
        _model = StateObject(wrappedValue: WorkspaceStore(api: api ?? CustomerAPI(baseURL: MobileAuthStore.apiURL) { force in try await auth.accessToken(forceRefresh: force) }, preferences: api == nil ? .standard : nil))
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Group {
                    if sizeClass == .regular {
                        NavigationSplitView(columnVisibility: $columnVisibility) {
                            sidebar(close: nil)
                                .navigationSplitViewColumnWidth(min: 240, ideal: 280, max: 340)
                        } detail: { content }
                        .navigationSplitViewStyle(.balanced)
                    } else { content }
                }
                .accessibilityHidden(navigation.sidebarPresented)
                .allowsHitTesting(!navigation.sidebarPresented)
                if navigation.sidebarPresented && sizeClass != .regular {
                    Color.black.opacity(0.35).ignoresSafeArea()
                        .onTapGesture { closeSidebar() }
                        .accessibilityHidden(true)
                    sidebar(close: closeSidebar)
                        .frame(width: min(340, geometry.size.width - 32))
                        .background(MobileTheme.sidebar)
                        .transition(.move(edge: .leading))
                        .accessibilityAddTraits(.isModal)
                        .accessibilityAction(.escape) { closeSidebar() }
                }
            }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: navigation.sidebarPresented)
        }
        .task { await model.connect() }
        .onChange(of: sizeClass) { _, _ in navigation.sidebarPresented = false }
        .onChange(of: model.context) { _, _ in navigation.path = []; editor = nil; filtersPresented = false }
        .sheet(item: $editor) { MobileEditor(model: model, request: $0) }
        .sheet(isPresented: $filtersPresented) { MobileInboxFilters(model: model) }
    }
    private var content: some View {
        NavigationStack(path: $navigation.path) {
            workspace
                .navigationDestination(for: MobileRoute.self) { route in
                    switch route {
                    case .record(let id):
                        MobileRecordDetail(model: model, id: id, isActive: navigation.path.last == route)
                            .accessibilityHidden(navigation.sidebarPresented)
                            .allowsHitTesting(!navigation.sidebarPresented)
                            .toolbar { menuToolbar }
                    case .projects:
                        MobileProjectsView(model: model) { project in
                            if project != model.projectID {
                                navigation.path = []
                                model.projectID = project
                            } else { navigation.path.removeLast() }
                        }
                    case .account:
                        MobileAccountView(auth: auth, model: model) {
                            navigation = MobileNavigation()
                            model.resetAccount()
                        }
                    }
                }
        }
    }
    private func sidebar(close: (() -> Void)?) -> some View {
        MobileSidebar(model: model, route: navigation.path.last, close: close) { section in
            navigation.path = []
            if model.section != section { model.section = section }
            closeSidebar()
        } open: { route in
            if navigation.path.last != route {
                if navigation.path.last == .projects || navigation.path.last == .account { navigation.path.removeLast() }
                navigation.path.append(route)
            }
            closeSidebar()
        }
    }
    private func closeSidebar() {
        navigation.sidebarPresented = false
        menuFocused = true
    }
    @ToolbarContentBuilder private var menuToolbar: some ToolbarContent {
        if sizeClass != .regular {
            ToolbarItem(placement: .topBarLeading) {
                Button { navigation.sidebarPresented = true } label: { Image(systemName: "sidebar.left").foregroundStyle(MobileTheme.foreground) }
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Open sidebar")
                    .accessibilityIdentifier("open-sidebar")
                    .accessibilityFocused($menuFocused)
            }
        }
    }
    private var workspace: some View {
        workspaceList
            .accessibilityHidden(navigation.sidebarPresented)
            .allowsHitTesting(!navigation.sidebarPresented)
            .modifier(MobileWorkspaceSearch(model: model))
            .navigationTitle(model.section.mobileTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                menuToolbar
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 2) {
                        Text(model.section.mobileTitle).font(.headline)
                        Text(model.currentProject?.title ?? "No project selected")
                            .font(.caption).foregroundStyle(MobileTheme.mutedForeground).lineLimit(1)
                    }.accessibilityElement(children: .combine)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if canCreate {
                        Button { create() } label: { MobileIcon(name: "plus") }
                            .accessibilityLabel("Create " + model.section.rawValue)
                            .accessibilityIdentifier("create-item").disabled(model.busy)
                    }
                }
            }
            .refreshable { await model.connect() }
            .task(id: "\(model.context):\(scenePhase):\(navigation.path.isEmpty)") {
                guard scenePhase == .active, navigation.path.isEmpty else { return }
                await model.poll()
            }
    }
    private var workspaceList: some View {
        List {
            if model.projectID.isEmpty {
                TSQEmptyState(icon: "folder", title: "No projects", message: "Open Projects to refresh your available workspaces.")
                Button("Projects") { navigation.path.append(.projects) }
            } else if model.section.isLibrary {
                Picker("Library", selection: $model.section) {
                    ForEach([WorkspaceSection.skills, .subAgents, .commands]) { Text($0.rawValue).tag($0) }
                }.accessibilityIdentifier("library-picker")
            }
            if !model.projectID.isEmpty {
                if model.section == .settings { settings }
                else if model.section == .analytics { analytics }
                else {
                    if model.section == .inbox {
                        Button { filtersPresented = true } label: {
                            HStack {
                                Image(systemName: "line.3.horizontal.decrease")
                                Text("Filters")
                                if model.status != "all" || model.origin != "all" {
                                    Text(String([model.status, model.origin].filter { $0 != "all" }.count))
                                        .font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 3)
                                        .background(MobileTheme.muted, in: Capsule())
                                }
                            }.frame(minHeight: 44)
                        }.accessibilityIdentifier("inbox-filters")
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
                    else if model.visibleRecords.isEmpty { TSQEmptyState(icon: "inbox", title: "No \(model.section.rawValue.lowercased())", message: "Choose another project or create a new item.").listRowBackground(Color.clear) }
                    else if model.section == .portals {
                        portalSection("Active sessions", live: true)
                        portalSection("History", live: false)
                    } else {
                        Section { ForEach(model.visibleRecords) { record in row(record) } }
                    }
                    if model.hasMore { Button("Load more") { Task { await model.refresh(loadMore: true) } }.disabled(model.loading) }
                    if let refreshedAt = model.refreshedAt { Text("Updated \(refreshedAt.formatted(date: .omitted, time: .shortened))").font(.caption).foregroundStyle(MobileTheme.mutedForeground) }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let error = model.error { Text(error).font(.footnote).foregroundStyle(MobileTheme.destructive).padding().frame(maxWidth: .infinity).background(.regularMaterial).accessibilityIdentifier("workspace-error") }
        }
        .scrollContentBackground(.hidden).background(MobileTheme.background)
    }
    private var canCreate: Bool { model.canCreate }
    @ViewBuilder private func portalSection(_ title: String, live: Bool) -> some View {
        let values = model.visibleRecords.filter { ["pending", "running"].contains($0.status) == live }
        if !values.isEmpty { Section(title) { ForEach(values) { row($0) } } }
        if live && !model.isPro { Text("Interactive Portals require an eligible account.").foregroundStyle(MobileTheme.mutedForeground) }
    }
    private func row(_ record: CustomerRecord) -> some View {
        Button { navigation.path.append(.record(record.id)) } label: {
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
            if !record.id.isEmpty { navigation.path = [.record(record.id)] }
            return true
        }
    }
    private var settings: some View {
        Section("Project") {
            Text(model.currentProject?.title ?? "No project selected")
            Text("Project role: \(model.currentProject?.text("role") ?? "member")")
            if model.canManage {
                Toggle("Learn from sessions", isOn: setting("learn_from_session"))
                Toggle("Project memory", isOn: setting("memory_enabled"))
            }
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

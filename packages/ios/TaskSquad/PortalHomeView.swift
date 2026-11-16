import TaskSquadPortalUI
import SwiftUI
import TaskSquadPortal
import TaskSquadDesign

/// iPhone tabs. The four most used sections get a tab; the rest are under More.
enum MobileTab: Hashable {
    case section(WorkspaceSection), more
    var section: WorkspaceSection? { if case .section(let value) = self { value } else { nil } }
}

/// The signed-in app. iPhone: a tab bar with a navigation stack per tab.
/// iPad: sidebar, record list and record side by side.
struct PortalHomeView: View {
    @ObservedObject var auth: MobileAuthStore
    @StateObject private var model: WorkspaceStore
    @StateObject private var actions: MobileActions
    @State private var tab = MobileTab.section(.inbox)
    @State private var path: [MobileRoute] = []
    @State private var selectedRecord: String?
    @State private var utility: MobileRoute?
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase

    init(auth: MobileAuthStore, api: CustomerAPI? = nil) {
        self.auth = auth
        let store = WorkspaceStore(api: api ?? CustomerAPI(baseURL: MobileAuthStore.apiURL) { force in try await auth.accessToken(forceRefresh: force) }, preferences: api == nil ? .standard : nil)
        _model = StateObject(wrappedValue: store)
        _actions = StateObject(wrappedValue: MobileActions(model: store))
    }
    private var regular: Bool { sizeClass == .regular }

    var body: some View {
        Group { if regular { splitLayout } else { tabLayout } }
            .task { await model.connect() }
            .onChange(of: model.projectID) { _, _ in path = []; selectedRecord = nil; actions.dismissAll() }
            .onChange(of: sizeClass) { _, _ in path = []; selectedRecord = nil }
            .modifier(MobileActionPresentations(actions: actions))
            .onAppear {
                actions.onRemoved = { id in
                    if selectedRecord == id { selectedRecord = nil }
                    if path.last == .record(id) { path.removeLast() }
                }
                actions.onOpenTask = openTask
            }
    }

    // MARK: iPhone

    private var tabLayout: some View {
        TabView(selection: $tab) {
            ForEach(WorkspaceSection.tabs) { section in
                Tab(value: MobileTab.section(section)) {
                    stack(.section(section)) { sectionScreen(section, root: true) }
                } label: { Label { Text(section.title) } icon: { TSQIcon.image(section.iconName) } }
                .accessibilityIdentifier("nav-" + section.rawValue)
            }
            Tab("More", systemImage: "ellipsis", value: MobileTab.more) {
                stack(.more) { MobileMoreList(model: model) }
            }
            .accessibilityIdentifier("nav-more")
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .onChange(of: tab) { _, value in
            path = []
            if let section = value.section, model.section != section { model.section = section }
        }
        // A section opened from More becomes the current section before its screen draws.
        .onChange(of: path) { _, value in
            if case .section(let section) = value.last, model.section.destination != section { model.section = section }
        }
    }
    private func stack<Root: View>(_ owner: MobileTab, @ViewBuilder root: () -> Root) -> some View {
        NavigationStack(path: tab == owner ? $path : .constant([])) {
            root().navigationDestination(for: MobileRoute.self) { route in
                switch route {
                case .record(let id):
                    MobileRecordDetail(model: model, actions: actions, id: id, isActive: path.last == route, openTask: openTask)
                case .section(let section): sectionScreen(section, root: false)
                case .projects: projects
                case .account: account
                }
            }
        }
    }
    private func sectionScreen(_ section: WorkspaceSection, root: Bool) -> some View {
        MobileSectionScreen(model: model, actions: actions, section: section,
                            isActive: scenePhase == .active && (path.isEmpty || path.last == .section(section)), selection: nil,
                            open: { path.append($0) })
    }
    private var projects: some View {
        MobileProjectsView(model: model) { project in
            utility = nil
            if project != model.projectID { model.projectID = project }
            // Choosing a project lands on its inbox, the place work starts.
            path = []
            if !regular { tab = .section(.inbox) }
            if model.section != .inbox { selectedRecord = nil; model.section = .inbox }
        }
    }
    private var account: some View {
        MobileAccountView(auth: auth, model: model) {
            utility = nil; path = []; tab = .section(.inbox)
            model.resetAccount()
        }
    }
    /// Opens a task from anywhere (a note's linked task, a forwarded task).
    private func openTask(_ id: String) {
        if model.section != .inbox { model.section = .inbox }
        if regular { selectedRecord = id }
        else if tab != .section(.inbox) { tab = .section(.inbox); Task { path = [.record(id)] } }
        else { path = [.record(id)] }
    }

    // MARK: iPad

    private var splitLayout: some View {
        NavigationSplitView {
            List(selection: Binding<WorkspaceSection?>(get: { model.section.destination }, set: { value in
                if let value, model.section.destination != value { selectedRecord = nil; model.section = value }
            })) {
                ForEach(WorkspaceSection.groups) { group in
                    Section(group.title) {
                        ForEach(group.sections) { section in
                            Label { Text(section.title) } icon: { TSQIcon.image(section.iconName) }
                                .tag(section).accessibilityIdentifier("nav-" + section.rawValue)
                        }
                    }
                }
                Section {
                    Button { utility = .projects } label: { Label(model.currentProject?.title ?? "Projects", systemImage: "folder") }
                        .accessibilityIdentifier("nav-projects")
                    Button { utility = .account } label: { Label("Account", systemImage: "person.crop.circle") }
                        .accessibilityIdentifier("nav-account")
                }
            }
            .navigationTitle("TaskSquad")
        } content: {
            MobileSectionScreen(model: model, actions: actions, section: model.section.destination, isActive: scenePhase == .active,
                                selection: $selectedRecord, open: { if case .record(let id) = $0 { selectedRecord = id } else { utility = $0 } })
        } detail: {
            NavigationStack {
                if let id = selectedRecord {
                    MobileRecordDetail(model: model, actions: actions, id: id, isActive: scenePhase == .active, openTask: openTask).id(id)
                } else {
                    ContentUnavailableView("No \(model.section.itemName.capitalized) Selected", systemImage: "sidebar.right", description: Text("Choose one from the list."))
                }
            }
        }
        .sheet(item: $utility) { route in
            NavigationStack {
                Group { if route == .account { account } else { projects } }
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { utility = nil } } }
            }
        }
    }
}

/// One section's records: search, filters, create, and per-row actions.
struct MobileSectionScreen: View {
    @ObservedObject var model: WorkspaceStore
    @ObservedObject var actions: MobileActions
    let section: WorkspaceSection
    let isActive: Bool
    /// iPad: the selected record. iPhone: `nil`, rows push instead.
    let selection: Binding<String?>?
    let open: (MobileRoute) -> Void

    /// The store still holds the previous section for one update after a push from More.
    private var current: Bool { model.section.destination == section }

    var body: some View {
        Group {
            if !current { ProgressView() }
            else if model.projectID.isEmpty { noProject }
            else if section == .settings { MobileProjectSettings(model: model) }
            else { list }
        }
        .modifier(MobileWorkspaceSearch(model: model, enabled: current))
        .navigationTitle(section.title)
        .navigationSubtitle(model.currentProject?.title ?? "")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { if selection == nil { projectMenu } }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if current, !model.projectID.isEmpty, MobileViewOptions.available(for: model.section) { MobileViewOptions(model: model) }
                if current, model.canCreate {
                    Button(actions.createTitle, systemImage: "plus") { actions.create { open(.record($0)) } }
                        .disabled(model.busy).accessibilityIdentifier("create-item")
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let error = actions.error ?? model.error, current {
                TSQErrorBanner(error, identifier: "workspace-error") { actions.error = nil; model.error = nil }
                    .padding(.horizontal).padding(.vertical, 8).background(.bar)
            }
        }
        .onChange(of: model.archived) { _, _ in Task { await model.refresh() } }
        .onChange(of: model.memoryCategory) { _, _ in Task { await model.refresh() } }
        .refreshable { await model.connect() }
        .task(id: "\(model.context):\(isActive)") {
            guard isActive, current else { return }
            await model.poll()
        }
    }

    private var noProject: some View {
        ContentUnavailableView {
            Label("No projects", systemImage: "folder")
        } description: { Text("Open Projects to refresh your available workspaces.") } actions: {
            Button("Projects") { open(.projects) }
        }
    }

    /// The current project; switching is one tap and a choice.
    private var projectMenu: some View {
        Menu {
            ForEach(model.projects) { project in
                Button { if model.projectID != project.id { model.projectID = project.id } } label: {
                    if model.projectID == project.id { Label(project.title, systemImage: "checkmark") } else { Text(project.title) }
                }.accessibilityIdentifier("project-" + project.id)
            }
            Divider()
            Button("All Projects…", systemImage: "folder") { open(.projects) }.accessibilityIdentifier("nav-projects")
        } label: { Label(model.currentProject?.title ?? "Projects", systemImage: "folder") }
        .accessibilityLabel("Project: " + (model.currentProject?.title ?? "none"))
        .accessibilityHint("Switch project").accessibilityIdentifier("switch-project")
    }

    private var list: some View {
        List(selection: selection ?? .constant(nil)) {
            if model.section.isLibrary {
                Picker("Library", selection: $model.section) {
                    ForEach(WorkspaceSection.libraries) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).listRowSeparator(.hidden).accessibilityIdentifier("library-selector")
            }
            if model.section == .inbox { MobileInboxScope(model: model) }
            if model.section == .analytics { MobileAnalytics(model: model) }
            else {
                if model.section == .portals, let note = portalNote {
                    Text(note).font(.footnote).foregroundStyle(.secondary).listRowSeparator(.hidden)
                }
                if model.section == .memory, !model.rollups.isEmpty {
                    Section(model.rollupPeriod.capitalized + " rollups") {
                        ForEach(model.rollups) { rollup in DisclosureGroup(rollup.title) { MarkdownContent(rollup.text("content")) } }
                    }
                }
                if model.loading { HStack { Spacer(); ProgressView("Loading…"); Spacer() }.listRowSeparator(.hidden) }
                else if model.error != nil && model.records.isEmpty {
                    Button("Retry") { Task { await model.refresh() } }
                }
                else if model.visibleRecords.isEmpty { emptyState.listRowSeparator(.hidden) }
                else if model.section == .portals {
                    portalSection("Active sessions", live: true)
                    portalSection("History", live: false)
                } else {
                    Section { ForEach(model.visibleRecords) { row($0) } }
                }
                if model.hasMore { Button("Load More") { Task { await model.refresh(loadMore: true) } }.disabled(model.loading) }
            }
        }
        .listStyle(.plain)
    }
    private var portalNote: String? {
        if !model.isPro { return "Interactive Portals require an eligible account." }
        if model.eligibleAgents.isEmpty { return "No available agents. Bring an agent online to open a Portal." }
        if model.records.filter({ PortalLifecycle.isLive($0.status) }).count >= 3 { return "Three sessions are active. Close one to open another." }
        return nil
    }
    private var filtered: Bool {
        (model.section == .inbox && (model.status != "all" || model.origin != "all"))
            || (model.section == .notes && model.archived) || (model.section == .memory && model.memoryCategory != "all")
    }
    @ViewBuilder private var emptyState: some View {
        if filtered || !model.search.isEmpty {
            ContentUnavailableView {
                Label("No matching results", systemImage: "magnifyingglass")
            } description: { Text("Try another search or clear your filters.") } actions: {
                Button("Clear search and filters") {
                    model.search = ""; model.status = "all"; model.origin = "all"; model.archived = false; model.memoryCategory = "all"
                }.accessibilityIdentifier("clear-filters")
            }
        } else {
            TSQEmptyState(icon: model.section.iconName, title: model.section == .inbox ? "No tasks yet" : "No \(model.section.rawValue.lowercased()) yet",
                          message: model.canCreate ? "Create a \(model.section.itemName) to get started." : "Items will appear here when available.")
        }
    }
    @ViewBuilder private func portalSection(_ title: String, live: Bool) -> some View {
        let values = model.visibleRecords.filter { PortalLifecycle.isLive($0.status) == live }
        if !values.isEmpty { Section(title) { ForEach(values) { row($0) } } }
    }
    @ViewBuilder private func row(_ record: CustomerRecord) -> some View {
        let content = TSQRecordRow(title: model.section == .portals ? model.agentName(record.text("agent_id")) : model.displayTitle(record),
                                   status: record.status, paused: record.flag("paused"), detail: detail(record),
                                   date: model.section != .members && record.number("created_at") > 0 ? record.date : nil)
        Group {
            if selection != nil { content.tag(record.id) }
            else { NavigationLink(value: MobileRoute.record(record.id)) { content } }
        }
        .accessibilityIdentifier("record-" + record.id)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            ForEach(model.actions(for: record).filter { $0.placement == .destructive }.reversed()) { action in
                Button(role: action.isDestructive ? .destructive : nil) { actions.perform(action, on: record) } label: { Label(action.title, systemImage: action.systemImage) }
                    .tint(action.isDestructive ? nil : MobileTheme.amber)
            }
        }
        .swipeActions(edge: .leading) {
            ForEach(model.actions(for: record).filter { $0.placement == .primary }) { action in
                Button { actions.perform(action, on: record) } label: { Label(action.title, systemImage: action.systemImage) }.tint(MobileTheme.tint)
            }
        }
        .contextMenu { MobileActionMenu(actions: actions, record: record) }
    }
    private func detail(_ record: CustomerRecord) -> String? {
        if model.section == .inbox, !record.text("agent_id").isEmpty { return model.agentName(record.text("agent_id")) }
        if model.section == .members, !record.text("role").isEmpty { return record.text("role").capitalized }
        if model.section == .agents, !record.status.isEmpty { return nil }
        return nil
    }
}

/// Everything that is not a tab on iPhone, plus Projects and Account.
struct MobileMoreList: View {
    @ObservedObject var model: WorkspaceStore
    var body: some View {
        List {
            Section {
                NavigationLink(value: MobileRoute.projects) {
                    LabeledContent { Text(model.currentProject?.title ?? "None").lineLimit(1) } label: { Label("Projects", systemImage: "folder") }
                }.accessibilityIdentifier("nav-projects")
            }
            ForEach(WorkspaceSection.groups) { group in
                let sections = group.sections.filter { !WorkspaceSection.tabs.contains($0) }
                if !sections.isEmpty {
                    Section(group.title) {
                        ForEach(sections) { section in
                            NavigationLink(value: MobileRoute.section(section)) {
                                Label { Text(section.title) } icon: { TSQIcon.image(section.iconName) }
                            }.accessibilityIdentifier("nav-" + section.rawValue)
                        }
                    }
                }
            }
            Section {
                NavigationLink(value: MobileRoute.account) { Label("Account", systemImage: "person.crop.circle") }
                    .accessibilityIdentifier("nav-account")
            }
        }
        .navigationTitle("More")
    }
}

struct MobileProjectSettings: View {
    @ObservedObject var model: WorkspaceStore
    var body: some View {
        Form {
            Section("Project") {
                LabeledContent("Name", value: model.currentProject?.title ?? "No project selected")
                LabeledContent("Your role", value: (model.currentProject?.text("role") ?? "member").capitalized)
            }
            if model.canManage {
                Section {
                    Toggle("Learn from sessions", isOn: setting("learn_from_session"))
                    Toggle("Project memory", isOn: setting("memory_enabled"))
                } footer: { Text("Agents can save what they learn in this project and reuse it in later tasks.") }
            }
        }
    }
    private func setting(_ key: String) -> Binding<Bool> { Binding(get: { model.currentProject?.flag(key) ?? false }, set: { value in Task { if await model.perform(.setProjectFlag(project: model.projectID, key: key, value)) != nil { await model.connect() } } }) }
}

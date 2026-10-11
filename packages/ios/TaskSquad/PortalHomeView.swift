import SwiftUI
import TaskSquadPortal

struct PortalRow: Identifiable, Hashable {
    let id: String
    let agent: String
    let state: String
    let sessionID: String
}

@MainActor
private final class PortalHomeModel: ObservableObject {
    @Published var projects: [PortalProject] = []
    @Published var selectedProject = ""
    @Published var portals: [PortalRow] = []
    @Published var agents: [PortalAgent] = []
    @Published var loading = false
    @Published var error: String?
    let api: PortalAPI?
    let demo: Bool

    init(token: String) {
        demo = ProcessInfo.processInfo.arguments.contains("--ui-test-demo")
        api = demo ? nil : PortalAPI(baseURL: MobileAuthStore.apiURL, token: { _ in token })
        if demo {
            projects = []
            selectedProject = "demo-project"
            portals = [PortalRow(id: "demo-portal", agent: "Demo Agent", state: "running", sessionID: "demo-session")]
        }
    }

    func refresh() async {
        guard !demo, let api else { return }
        loading = true
        defer { loading = false }
        do {
            let nextProjects = try await api.projects()
            projects = nextProjects
            if selectedProject.isEmpty || !nextProjects.contains(where: { $0.id == selectedProject }) {
                selectedProject = nextProjects.first?.id ?? ""
            }
            guard !selectedProject.isEmpty else { portals = []; agents = []; return }
            async let nextPortals = api.portals(projectID: selectedProject)
            async let nextAgents = api.agents(projectID: selectedProject)
            let records = try await nextPortals
            let projectAgents = try await nextAgents
            agents = projectAgents
            let names = Dictionary(uniqueKeysWithValues: projectAgents.map { ($0.id, $0.name) })
            portals = records.map { PortalRow(id: $0.id, agent: names[$0.agentID] ?? $0.agentID, state: $0.status, sessionID: $0.sessionID ?? "") }
            error = nil
        } catch let failure { self.error = failure.localizedDescription }
    }

    func open(agentID: String) async {
        guard !demo, let api, !selectedProject.isEmpty else { return }
        do {
            let result = try await api.createPortal(projectID: selectedProject, agentID: agentID)
            _ = result
            await refresh()
        } catch let failure { self.error = failure.localizedDescription }
    }

    func close(_ portal: PortalRow) async {
        guard !demo, let api else { portals.removeAll { $0.id == portal.id }; return }
        do { try await api.closePortal(id: portal.id); await refresh() }
        catch let failure { self.error = failure.localizedDescription }
    }
}

struct PortalHomeView: View {
    @ObservedObject var auth: MobileAuthStore
    @StateObject private var model: PortalHomeModel
    @State private var selectedPortal: PortalRow?
    @State private var showOpenSheet = false
    @State private var confirmClose: PortalRow?

    init(auth: MobileAuthStore, token: String) {
        self.auth = auth
        _model = StateObject(wrappedValue: PortalHomeModel(token: token))
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.loading && model.portals.isEmpty { ProgressView("Loading Portals…") }
                else if model.portals.isEmpty { ContentUnavailableView("No Portals open", systemImage: "terminal", description: Text("Open an interactive agent session to get started.")) }
                else {
                    List {
                        if model.demo { Section("Project") { Label("Demo Workspace", systemImage: "folder") } }
                        else if !model.projects.isEmpty {
                            Section("Project") {
                                Picker("Workspace", selection: $model.selectedProject) {
                                    ForEach(model.projects) { Text($0.name).tag($0.id) }
                                }.onChange(of: model.selectedProject) { _, _ in Task { await model.refresh() } }
                            }
                        }
                        Section("Live Portals") {
                            ForEach(model.portals) { portal in
                                Button { selectedPortal = portal } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "terminal.fill").foregroundStyle(.tint)
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(portal.agent).font(.headline)
                                            Text(portal.state.capitalized).font(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                                    }.contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityIdentifier("portal-row-\(portal.id)")
                                    .swipeActions {
                                        Button(role: .destructive) { confirmClose = portal } label: { Label("Close", systemImage: "xmark") }
                                    }
                            }
                        }
                    }.refreshable { await model.refresh() }
                }
            }
            .navigationTitle("Portals")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if !model.demo { Button("Sign out") { Task { await auth.signOut() } } }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showOpenSheet = true } label: { Image(systemName: "plus") }.accessibilityLabel("Open Portal")
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let error = model.error { Text(error).font(.footnote).foregroundStyle(.red).padding().frame(maxWidth: .infinity) }
            }
            .task { await model.refresh() }
            .task { while !Task.isCancelled { try? await Task.sleep(for: .seconds(5)); await model.refresh() } }
            .sheet(isPresented: $showOpenSheet) { openSheet }
            .navigationDestination(item: $selectedPortal) { portal in PortalTerminalScreen(portal: portal, api: model.api, demo: model.demo, close: { Task { await model.close(portal); selectedPortal = nil } }) }
            .confirmationDialog("Close this Portal?", isPresented: Binding(get: { confirmClose != nil }, set: { if !$0 { confirmClose = nil } }), titleVisibility: .visible) {
                Button("Close Portal", role: .destructive) { if let item = confirmClose { Task { await model.close(item) } }; confirmClose = nil }
            } message: { Text("The remote terminal session will be closed.") }
        }
    }

    private var openSheet: some View {
        NavigationStack {
            List {
                if model.demo { Text("Sign in to open a live Portal.").foregroundStyle(.secondary) }
                ForEach(model.agents) { agent in
                    Button { Task { await model.open(agentID: agent.id); showOpenSheet = false } } label: {
                        HStack { VStack(alignment: .leading) { Text(agent.name); Text(agent.status ?? "Available").font(.caption).foregroundStyle(.secondary) }; Spacer(); Image(systemName: "plus.circle") }
                    }
                }
            }.navigationTitle("Choose an agent")
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { showOpenSheet = false } } }
                .task { await model.refresh() }
        }.presentationDetents([.medium, .large])
    }
}

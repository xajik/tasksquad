import SwiftUI
import TaskSquadPortal
import TaskSquadPortalUI

enum MobileRoute: Hashable {
    case record(String), projects, account
}

struct MobileNavigation {
    var path: [MobileRoute] = []
    var sidebarPresented = false
}

extension WorkspaceSection {
    var mobileTitle: String {
        switch self {
        case .conveyors: "Conveyor"
        case .planners: "Planner"
        case .settings: "Project Settings"
        default: rawValue
        }
    }
    var mobileIcon: String {
        switch self {
        case .inbox: "inbox"
        case .portals: "monitor"
        case .notes: "file-text"
        case .conveyors: "repeat"
        case .planners: "list-checks"
        case .supervisor: "shield-alert"
        case .skills, .subAgents, .commands: "book-open"
        case .memory: "database"
        case .analytics: "chart-column"
        case .agents: "bot"
        case .members: "users"
        case .settings: "settings"
        }
    }
}

struct MobileSidebar: View {
    @ObservedObject var model: WorkspaceStore
    let route: MobileRoute?
    let close: (() -> Void)?
    let select: (WorkspaceSection) -> Void
    let open: (MobileRoute) -> Void
    @AccessibilityFocusState private var closeFocused: Bool
    static let sections: [WorkspaceSection] = [.inbox, .portals, .notes, .conveyors, .planners, .supervisor, .skills, .memory, .analytics, .agents, .members, .settings]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("TaskSquad").font(.title3.bold())
                Spacer()
                if let close {
                    Button(action: close) { MobileIcon(name: "x") }
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityLabel("Close sidebar").accessibilityIdentifier("close-sidebar")
                        .accessibilityFocused($closeFocused)
                }
            }.padding(.horizontal, 16).padding(.vertical, 8)
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(Self.sections) { section in
                        let selected = route != .projects && route != .account && (model.section == section || section == .skills && model.section.isLibrary)
                        item(section == .skills ? "Skills & Sub-agents" : section.mobileTitle,
                             icon: section.mobileIcon, selected: selected, identifier: "nav-" + section.rawValue) { select(section) }
                    }
                    Divider().padding(.vertical, 10)
                    item("Projects", subtitle: model.currentProject?.title ?? "No project selected", icon: "folder", selected: route == .projects, identifier: "nav-projects") { open(.projects) }
                    item("Account", icon: "user", selected: route == .account, identifier: "nav-account") { open(.account) }
                }.padding(.horizontal, 8).padding(.bottom, 16)
            }.accessibilityIdentifier("sidebar-destinations")
        }
        .foregroundStyle(MobileTheme.foreground)
        .background(MobileTheme.sidebar)
        .task { if close != nil { closeFocused = true } }
    }
    private func item(_ title: String, subtitle: String? = nil, icon: String, selected: Bool, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                MobileIcon(name: icon).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.body.weight(selected ? .semibold : .regular))
                    if let subtitle { Text(subtitle).font(.caption).foregroundStyle(MobileTheme.mutedForeground) }
                }.fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(selected ? MobileTheme.accent : .clear, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct MobileProjectsView: View {
    @ObservedObject var model: WorkspaceStore
    let select: (String) -> Void
    @State private var search = ""
    @State private var loading = false
    private var projects: [CustomerRecord] { model.projects.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) } }

    var body: some View {
        List {
            if loading && model.projects.isEmpty { ProgressView("Loading projects…") }
            if let error = model.error {
                TSQErrorBanner(error)
                Button("Retry") { Task { await refresh() } }
            }
            if !loading && projects.isEmpty {
                TSQEmptyState(icon: "folder", title: search.isEmpty ? "No projects" : "No matching projects", message: search.isEmpty ? "Your projects will appear here. Pull to refresh." : "Try another project name.")
                    .listRowBackground(Color.clear)
            }
            ForEach(projects) { project in
                Button { select(project.id) } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(project.title).font(.body).foregroundStyle(MobileTheme.foreground)
                            Text(project.text("role").capitalized).font(.caption).foregroundStyle(MobileTheme.mutedForeground)
                        }.fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        if model.projectID == project.id { MobileIcon(name: "check").accessibilityHidden(true) }
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }
                .accessibilityIdentifier("project-" + project.id)
                .accessibilityAddTraits(model.projectID == project.id ? .isSelected : [])
            }
        }
        .scrollContentBackground(.hidden).background(MobileTheme.background)
        .navigationTitle("Projects").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, prompt: "Search projects")
        .refreshable { await refresh() }
        .task { await refresh() }
    }
    private func refresh() async {
        loading = true
        model.error = nil
        await model.connect(refresh: false)
        loading = false
    }
}

struct MobileAccountView: View {
    @ObservedObject var auth: MobileAuthStore
    @ObservedObject var model: WorkspaceStore
    let signedOut: () -> Void
    @AppStorage("mobile.appearance") private var appearance = "system"
    @State private var signingOut = false
    var body: some View {
        Form {
            Section("Account") {
                Text(model.profile?.text("email") ?? "").textSelection(.enabled)
                LabeledContent("Plan", value: model.isPro ? "Pro" : "Free")
            }
            Section("Preferences") {
                Picker("Appearance", selection: $appearance) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
            }
            Section {
                DisclosureGroup("Connection information") {
                    Text(model.api.baseURL.absoluteString).font(.footnote).textSelection(.enabled)
                }
            }
            Section {
                Button("Sign out", role: .destructive) {
                    signingOut = true
                    Task { await auth.signOut(); signedOut() }
                }.disabled(signingOut)
            }
        }
        .scrollContentBackground(.hidden).background(MobileTheme.background)
        .navigationTitle("Account").navigationBarTitleDisplayMode(.inline)
    }
}

struct MobileInboxFilters: View {
    @ObservedObject var model: WorkspaceStore
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Picker("Status", selection: $model.status) {
                    ForEach(["all", "pending", "running", "waiting_input", "scheduled", "wrapping_up", "done", "failed"], id: \.self) {
                        Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0)
                    }
                }.accessibilityIdentifier("status-filter")
                Picker("Origin", selection: $model.origin) {
                    ForEach(["all", "mine", "system", "scheduled", "planner", "conveyor", "from-note", "note-critique"], id: \.self) {
                        Text($0.replacingOccurrences(of: "-", with: " ").capitalized).tag($0)
                    }
                }.accessibilityIdentifier("origin-filter")
                Button("Reset filters") { model.status = "all"; model.origin = "all" }
            }
            .navigationTitle("Filters").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("filters-done") } }
        }
    }
}

struct MobileWorkspaceSearch: ViewModifier {
    @ObservedObject var model: WorkspaceStore
    func body(content: Content) -> some View {
        if [.settings, .analytics].contains(model.section) { content }
        else { content.searchable(text: $model.search, prompt: "Search " + model.section.rawValue) }
    }
}

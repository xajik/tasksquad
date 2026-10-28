import SwiftUI
import TaskSquadPortal
import TaskSquadPortalUI
import TaskSquadDesign

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
    /// Singular item name for "New …" actions and editor titles.
    var mobileItem: String {
        switch self {
        case .inbox, .supervisor: "task"
        case .portals: "portal"
        case .notes: "note"
        case .conveyors: "conveyor"
        case .planners: "planner"
        case .skills: "skill"
        case .subAgents: "sub-agent"
        case .commands: "command"
        case .memory: "memory"
        case .agents: "agent"
        case .members: "member"
        case .analytics, .settings: rawValue.lowercased()
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

extension WorkspaceStore {
    /// Members only see teammates' emails as owners or maintainers; everyone
    /// else gets a readable label instead of a raw user ID.
    func displayTitle(_ record: CustomerRecord) -> String {
        guard section == .members, record.text("email").isEmpty else { return record.title }
        return record.id == profile?.text("id") ? "You" : "Teammate"
    }
}

struct MobileSidebar: View {
    @ObservedObject var model: WorkspaceStore
    let route: MobileRoute?
    let close: (() -> Void)?
    let select: (WorkspaceSection) -> Void
    let open: (MobileRoute) -> Void
    @AccessibilityFocusState private var closeFocused: Bool
    private static let groups: [(String, [WorkspaceSection])] = [
        ("Work", [.inbox, .notes, .portals]),
        ("Automation", [.conveyors, .planners, .supervisor]),
        ("Resources", [.skills, .memory]),
        ("Manage", [.agents, .members, .analytics, .settings])
    ]

    var body: some View {
        VStack(spacing: 0) {
            // DESIGN.md §7.2: 20pt logo + 18pt bold wordmark, 16 × 20 padding.
            HStack(spacing: 8) {
                TSQLogo(size: 20)
                Text("TaskSquad").font(.system(size: 18, weight: .bold))
                Spacer()
                if let close {
                    Button(action: close) { MobileIcon(name: "x", size: 16) }
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityLabel("Close sidebar").accessibilityIdentifier("close-sidebar")
                        .accessibilityFocused($closeFocused)
                }
            }.padding(.leading, 20).padding(.trailing, 8).frame(minHeight: 56)
            item("Projects", subtitle: model.currentProject?.title ?? "No project selected", icon: "folder", selected: route == .projects, identifier: "nav-projects") { open(.projects) }
                .padding(.horizontal, 8).padding(.bottom, 8)
            ScrollView {
                VStack(spacing: 4) {
                    ForEach(Self.groups.indices, id: \.self) { index in
                        Text(Self.groups[index].0.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(MobileTheme.mutedForeground)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.top, 16).padding(.bottom, 4)
                        ForEach(Self.groups[index].1) { section in
                            let selected = route != .projects && route != .account && (model.section == section || section == .skills && model.section.isLibrary)
                            item(section == .skills ? "Library" : section.mobileTitle,
                                 icon: section.mobileIcon, selected: selected, identifier: "nav-" + section.rawValue) { select(section) }
                        }
                    }
                }.padding(.horizontal, 8).padding(.bottom, 16)
            }.accessibilityIdentifier("sidebar-destinations")
            Divider()
            item("Account", icon: "user", selected: route == .account, identifier: "nav-account") { open(.account) }
                .padding(8)
        }
        .foregroundStyle(MobileTheme.foreground)
        .background(MobileTheme.sidebar)
        .overlay(alignment: .trailing) { Rectangle().fill(MobileTheme.border).frame(width: 1).ignoresSafeArea() }
        .task { if close != nil { closeFocused = true } }
    }
    private func item(_ title: String, subtitle: String? = nil, icon: String, selected: Bool, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            // DESIGN.md §9.9: 16pt icon + 8pt gap; active = accent fill + accent-foreground,
            // inactive icons muted (§8). 44pt rows keep the iOS hit target (§9.1).
            HStack(spacing: 8) {
                MobileIcon(name: icon, size: 16).accessibilityHidden(true)
                    .foregroundStyle(selected ? MobileTheme.accentForeground : MobileTheme.mutedForeground)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.body.weight(selected ? .medium : .regular))
                        .foregroundStyle(selected ? MobileTheme.accentForeground : MobileTheme.foreground)
                    if let subtitle { Text(subtitle).font(.caption).foregroundStyle(MobileTheme.mutedForeground) }
                }.fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(selected ? MobileTheme.accent : .clear, in: RoundedRectangle(cornerRadius: MobileTheme.controlRadius))
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
                }
                .foregroundStyle(MobileTheme.destructive)
                .disabled(signingOut)
            }
        }
        .scrollContentBackground(.hidden).background(MobileTheme.background)
        .navigationTitle("Account").navigationBarTitleDisplayMode(.inline)
    }
}

/// The list screens' one navigation-bar quick action for how the list is
/// scoped: Inbox status/origin, archived notes, memory category, and which
/// library (Skills / Sub-agents / Commands) is shown. Every section uses the
/// same `list-filter` button, which fills when a non-default option is active.
struct MobileViewOptions: View {
    @ObservedObject var model: WorkspaceStore
    static func available(for section: WorkspaceSection) -> Bool {
        section == .inbox || section == .notes || section == .memory
    }
    private var active: Bool {
        switch model.section {
        case .inbox: model.status != "all" || model.origin != "all"
        case .notes: model.archived
        case .memory: model.memoryCategory != "all"
        default: false
        }
    }
    var body: some View {
        Menu {
            if model.section == .inbox {
                Picker(selection: $model.status) {
                    ForEach(["all", "pending", "running", "waiting_input", "scheduled", "wrapping_up", "done", "failed"], id: \.self) {
                        Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0)
                    }
                } label: { MobileMenuLabel("Status", icon: "circle-check") }
                .pickerStyle(.menu).accessibilityIdentifier("status-filter")
                Picker(selection: $model.origin) {
                    ForEach(["all", "mine", "system", "scheduled", "planner", "conveyor", "from-note", "note-critique"], id: \.self) {
                        Text($0.replacingOccurrences(of: "-", with: " ").capitalized).tag($0)
                    }
                } label: { MobileMenuLabel("Origin", icon: "network") }
                .pickerStyle(.menu).accessibilityIdentifier("origin-filter")
                if active {
                    Button { model.status = "all"; model.origin = "all" } label: { MobileMenuLabel("Reset filters", icon: "x") }
                }
            } else if model.section == .notes {
                Toggle(isOn: $model.archived) { MobileMenuLabel("Archived notes", icon: "folder") }
            } else if model.section == .memory {
                Picker(selection: $model.memoryCategory) {
                    ForEach(["all", "personal", "preferences", "structure", "architecture", "events"], id: \.self) { Text($0.capitalized).tag($0) }
                } label: { MobileMenuLabel("Category", icon: "layers") }
                .pickerStyle(.menu)
            } else if model.section.isLibrary {
                Picker("Library", selection: $model.section) {
                    ForEach([WorkspaceSection.skills, .subAgents, .commands]) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.inline)
            }
        } label: {
            MobileIcon(name: "list-filter")
                .padding(6)
                .background(active ? MobileTheme.accent : .clear, in: RoundedRectangle(cornerRadius: MobileTheme.controlRadius))
                .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(active ? "View options, filtered" : "View options")
        .accessibilityIdentifier("view-options")
    }
}

struct MobileWorkspaceSearch: ViewModifier {
    @ObservedObject var model: WorkspaceStore
    func body(content: Content) -> some View {
        if [.settings, .analytics].contains(model.section) { content }
        else { content.searchable(text: $model.search, prompt: "Search " + model.section.mobileTitle) }
    }
}

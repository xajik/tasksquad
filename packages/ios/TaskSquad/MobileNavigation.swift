import SwiftUI
import TaskSquadPortal
import TaskSquadPortalUI
import TaskSquadDesign

enum MobileRoute: Hashable, Identifiable {
    case record(String), section(WorkspaceSection), projects, account
    var id: Self { self }
}

extension WorkspaceStore {
    /// Members only see teammates' emails as owners or maintainers; everyone
    /// else gets a readable label instead of a raw user ID.
    func displayTitle(_ record: CustomerRecord) -> String {
        guard section == .members, record.text("email").isEmpty else { return record.title }
        return record.id == profile?.text("id") ? "You" : "Teammate"
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
                            Text(project.title).font(.body)
                            Text(project.text("role").capitalized).font(.caption).foregroundStyle(MobileTheme.mutedForeground)
                        }.fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        if model.projectID == project.id { Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityHidden(true) }
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain)
                .accessibilityIdentifier("project-" + project.id)
                .accessibilityAddTraits(model.projectID == project.id ? .isSelected : [])
            }
        }
        .navigationTitle("Projects").navigationBarTitleDisplayMode(.inline)
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("Search projects"))
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
    @State private var confirmSignOut = false
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
                Button("Sign out", role: .destructive) { confirmSignOut = true }
                    .disabled(signingOut)
                    .confirmationDialog("Sign out of TaskSquad?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                        Button("Sign Out", role: .destructive) {
                            signingOut = true
                            Task { await auth.signOut(); signedOut() }
                        }
                        Button("Cancel", role: .cancel) { }
                    } message: { Text("Drafts on this device are kept. Sign in again to see your projects.") }
            }
        }
        .navigationTitle("Account").navigationBarTitleDisplayMode(.inline)
    }
}

/// The list's filters, one level deep in a half-height sheet: Inbox status and
/// origin, archived notes, memory category and rollup period. The toolbar icon
/// fills when a filter is active.
struct MobileViewOptions: View {
    @ObservedObject var model: WorkspaceStore
    @State private var presented = false
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
    private func reset() { model.status = "all"; model.origin = "all"; model.archived = false; model.memoryCategory = "all" }
    var body: some View {
        Button("Filter", systemImage: active ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle") { presented = true }
            .accessibilityLabel(active ? "View options, filtered" : "View options")
            .accessibilityIdentifier("view-options")
            .sheet(isPresented: $presented) {
                NavigationStack {
                    Form {
                        if model.section == .inbox {
                            Picker("Status", selection: $model.status) {
                                ForEach(WorkspaceFilter.statuses, id: \.self) { Text(WorkspaceFilter.label($0, any: "Any status")).tag($0) }
                            }.accessibilityIdentifier("status-filter")
                            Picker("Origin", selection: $model.origin) {
                                ForEach(WorkspaceFilter.origins, id: \.self) { Text(WorkspaceFilter.label($0, any: "Any origin")).tag($0) }
                            }.accessibilityIdentifier("origin-filter")
                        } else if model.section == .notes {
                            Toggle("Show archived notes", isOn: $model.archived)
                        } else if model.section == .memory {
                            Picker("Category", selection: $model.memoryCategory) {
                                ForEach(WorkspaceFilter.memoryCategories, id: \.self) { Text(WorkspaceFilter.label($0, any: "Any category")).tag($0) }
                            }
                            Picker("Rollups", selection: $model.rollupPeriod) { Text("Daily").tag("daily"); Text("Weekly").tag("weekly") }
                        }
                    }
                    .navigationTitle("Filters").navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Reset") { reset() }.disabled(!active).accessibilityIdentifier("reset-filters") }
                        ToolbarItem(placement: .confirmationAction) { Button("Done") { presented = false }.accessibilityIdentifier("filters-done") }
                    }
                }
                .presentationDetents([.medium])
            }
    }
}

struct MobileWorkspaceSearch: ViewModifier {
    @ObservedObject var model: WorkspaceStore
    var enabled = true
    func body(content: Content) -> some View {
        if !enabled || [.settings, .analytics].contains(model.section) { content }
        else { content.searchable(text: $model.search, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("Search " + model.section.title)) }
    }
}

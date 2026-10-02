import AppKit
import SwiftUI
import TaskSquadCore

enum WindowID {
    static let main = "control-panel"
    static let thisMac = "this-mac"
}

/// The project workspace, laid out like the web dashboard. Everything here is
/// scoped to the selected project; machine-wide daemon views live in the
/// separate "This Mac" window.
struct MainWindow: View {
    @ObservedObject var control: ControlPanelModel
    @ObservedObject var customer: CustomerWorkspaceModel
    @State private var projectEditor: CustomerEditorRequest?
    @Environment(\.openWindow) private var openWindow
    private let initialSection: CustomerSection?
    static let sections: [CustomerSection] = [.inbox, .portals, .notes, .conveyors, .planners, .supervisor, .skills, .memory, .analytics, .agents, .members, .settings]
    private static let selectionKey = "section"

    init(control: ControlPanelModel, customer: CustomerWorkspaceModel, initialSection: CustomerSection? = nil) {
        self.control = control; self.customer = customer
        self.initialSection = initialSection ?? UserDefaults.standard.string(forKey: Self.selectionKey).flatMap(CustomerSection.init(rawValue:))
    }

    var body: some View {
        NavigationSplitView {
            sidebar.navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 280)
        } detail: {
            CustomerWorkspace(model: customer)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.background)
        }
        .navigationTitle(customer.section.isLibrary ? CustomerSection.skills.title : customer.section.title)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                DaemonControl(control: control)
                Button { openWindow(id: WindowID.thisMac) } label: { Label("This Mac", icon: .laptop).labelStyle(TSQLabelStyle(spacing: 6)) }
                    .help("Local agents, tmux sessions, logs, and daemon configuration on this Mac (⇧⌘M)")
            }
        }
        .tint(Theme.primary)
        .onAppear {
            if let initialSection, customer.section != initialSection { customer.section = initialSection }
            customer.active = true
        }
        .onDisappear { customer.active = false }
        .onChange(of: customer.section) { UserDefaults.standard.set($0.rawValue, forKey: Self.selectionKey) }
        .sheet(item: $projectEditor) { CustomerEditor(model: customer, request: $0) }
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                BrandLogo(size: 20)
                Text("TaskSquad").font(.system(size: 17, weight: .bold)).foregroundStyle(Theme.foreground)
            }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 14)
            ScrollView {
                VStack(spacing: 2) {
                    ForEach(Self.sections) { section in
                        SidebarItem(icon: section.icon, title: section.title,
                                    selected: customer.section == section || (section == .skills && customer.section.isLibrary)) {
                            customer.section = section
                        }
                    }
                }.padding(.horizontal, 8)
            }
            footer
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.sidebar)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 0) {
            if customer.profile != nil {
                VStack(alignment: .leading, spacing: 4) {
                    // Native popup button: the web's `SelectTrigger` equivalent.
                    Picker("Project", selection: $customer.teamID) {
                        if customer.teams.isEmpty { Text("No projects").tag("") }
                        ForEach(customer.teams) { Text($0.title).tag($0.id) }
                    }
                    .pickerStyle(.menu).labelsHidden().frame(maxWidth: .infinity)
                    Button { projectEditor = .newProject(model: customer) } label: { Label("New project", icon: .plus) }
                        .buttonStyle(TSQButtonStyle(variant: .ghost, size: .sm, fullWidth: true))
                        .foregroundStyle(Theme.mutedForeground)
                }.padding(8).edgeBorder(.top)
                Group {
                    if customer.isPro { Badge("Pro", variant: .default) }
                    else {
                        Button { customer.open("/pricing") } label: { Badge("Free plan") }.buttonStyle(.plain)
                    }
                }.padding(.horizontal, 16).padding(.bottom, 4)
            }
            VStack(spacing: 2) {
                SidebarItem(icon: .bookMarked, title: "Docs", muted: true) { customer.open("/docs") }
                if customer.profile != nil {
                    SidebarItem(icon: .logOut, title: "Sign out", muted: true) { Task { await customer.signOut() } }
                } else {
                    SidebarItem(icon: .user, title: customer.signingIn ? "Signing in…" : "Sign in", muted: true) { customer.signIn() }
                        .disabled(customer.signingIn)
                }
            }.padding(8)
        }
    }
}

/// Machine-wide window: the local daemon's agents, tmux sessions, task
/// journals, logs, and configuration. Independent of the selected project.
struct ThisMacWindow: View {
    @ObservedObject var control: ControlPanelModel
    @State private var section: PanelSection
    private static let selectionKey = "thisMac.section"

    init(control: ControlPanelModel, initialSection: PanelSection? = nil) {
        self.control = control
        let stored = UserDefaults.standard.string(forKey: Self.selectionKey).flatMap(PanelSection.init(rawValue:))
        _section = State(initialValue: initialSection ?? stored ?? .agents)
    }

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Icon(.laptop, size: 18).foregroundStyle(Theme.foreground)
                        .frame(width: 32, height: 32).background(Theme.muted, in: RoundedRectangle(cornerRadius: Theme.controlRadius))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Host.current().localizedName ?? "This Mac").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.foreground).lineLimit(1)
                        HStack(spacing: 5) {
                            StatusDot(active: control.engineRunning, size: 6)
                            Text(control.engineRunning ? "Daemon running" : control.observationDate != nil ? "Existing daemon" : "Daemon stopped")
                        }.font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                    }
                }.padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 14)
                VStack(spacing: 2) {
                    ForEach(PanelSection.allCases) { item in
                        SidebarItem(icon: item.icon, title: item.rawValue, selected: section == item) { section = item }
                    }
                }.padding(.horizontal, 8)
                Spacer()
                Text("Shared by every project on this Mac.").font(.system(size: 11)).foregroundStyle(Theme.mutedForeground).padding(16)
            }
            .frame(maxHeight: .infinity, alignment: .top)
            .background(Theme.sidebar)
            .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 260)
        } detail: {
            LocalSectionView(model: control, section: section)
        }
        .navigationTitle(section.rawValue)
        .toolbar { ToolbarItem(placement: .primaryAction) { DaemonControl(control: control) } }
        .tint(Theme.primary)
        .onChange(of: section) { UserDefaults.standard.set($0.rawValue, forKey: Self.selectionKey) }
        .onReceive(NotificationCenter.default.publisher(for: .showLocalSection)) { note in
            if let value = note.object as? PanelSection { section = value }
        }
    }
}

/// Toolbar pill that shows and toggles the local daemon.
struct DaemonControl: View {
    @ObservedObject var control: ControlPanelModel
    @State private var failure: String?
    var body: some View {
        Button {
            Task {
                if control.engineRunning { await control.stopEngine() }
                else { await control.startEngine(); if !control.engineRunning { failure = control.error } }
            }
        } label: {
            HStack(spacing: 6) {
                StatusDot(active: control.engineRunning, size: 7)
                Text(control.engineRunning ? "Daemon running" : "Daemon stopped").font(.system(size: 12, weight: .medium))
                Icon(control.engineRunning ? .square : .play, size: 11).foregroundStyle(Theme.mutedForeground)
            }.padding(.horizontal, 4)
        }
        .disabled(control.engineBusy || (!control.engineRunning && control.configuration == nil))
        .help(control.engineRunning ? "Stop the local daemon" : "Start the local daemon. It runs for every project on this Mac.")
        .alert("Daemon could not start", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK") { failure = nil }
        } message: { Text(failure ?? "") }
    }
}

struct SettingsView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Appearance").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.foreground)
                AppearancePicker()
                Text("System follows your Mac's Light or Dark setting.").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
            }
        }.padding(24).frame(width: 420, alignment: .leading)
    }
}

extension CustomerSection {
    /// Sidebar labels as the web app shows them.
    var title: String {
        switch self {
        case .conveyors: "Conveyor"
        case .planners: "Planner"
        case .skills: "Skills & Sub-agents"
        default: rawValue
        }
    }
}

extension CustomerEditorRequest {
    @MainActor static func newProject(model: CustomerWorkspaceModel) -> CustomerEditorRequest {
        CustomerEditorRequest(title: "New project", fields: [.init("name", "Project name", required: true)], submitLabel: "Create") { body, _ in
            guard let result = await model.mutate(["teams"], body: body) else { return false }
            await model.connect(); model.teamID = result["id"]?.string ?? model.teamID; return true
        }
    }
}

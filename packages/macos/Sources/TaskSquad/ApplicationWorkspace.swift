import AppKit
import SwiftUI
import TaskSquadCore
import TaskSquadDesign
import TaskSquadPortalUI

enum WindowID {
    static let main = "control-panel"
    static let thisMac = "this-mac"
}

/// The project workspace: a sidebar of sections, the section's records, and
/// the selected record. Everything here is scoped to the selected project;
/// machine-wide daemon views live in the separate "This Mac" window.
struct MainWindow: View {
    @ObservedObject var control: ControlPanelModel
    @ObservedObject var customer: CustomerWorkspaceModel
    @StateObject private var ui: WorkspaceUI
    @Environment(\.openWindow) private var openWindow
    private let initialSection: CustomerSection?
    static let sections = CustomerSection.destinations
    private static let selectionKey = "section"

    init(control: ControlPanelModel, customer: CustomerWorkspaceModel, initialSection: CustomerSection? = nil) {
        self.control = control; self.customer = customer
        _ui = StateObject(wrappedValue: WorkspaceUI(model: customer))
        self.initialSection = initialSection ?? UserDefaults.standard.string(forKey: Self.selectionKey).flatMap(CustomerSection.init(rawValue:))
    }
    /// Sections shown without a record list.
    private var fullWidth: Bool { customer.teamID.isEmpty || [.analytics, .settings].contains(customer.section) }

    var body: some View {
        Group {
            if customer.profile == nil { CustomerSignIn(model: customer).navigationTitle("TaskSquad") }
            else if fullWidth {
                NavigationSplitView { sidebar } detail: { CustomerProjectPage(model: customer, ui: ui) }
            } else {
                NavigationSplitView { sidebar } content: {
                    CustomerRecordList(model: customer, ui: ui).navigationSplitViewColumnWidth(min: 260, ideal: 340, max: 520)
                } detail: { CustomerDetail(model: customer, ui: ui) }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let error = customer.error { ErrorBanner(message: error) { customer.error = nil } }
        }
        .toolbar {
            ToolbarItemGroup(placement: .status) {
                DaemonControl(control: control)
                Button { openWindow(id: WindowID.thisMac) } label: { Label("This Mac", systemImage: "laptopcomputer") }
                    .help("Local agents, tmux sessions, logs and daemon configuration on this Mac (⇧⌘M)")
            }
        }
        .modifier(CustomerPresentations(model: customer, ui: ui))
        .focusedSceneObject(ui)
        .onAppear {
            if let initialSection, customer.section != initialSection { customer.section = initialSection }
            customer.active = true
        }
        .onDisappear { customer.active = false }
        .onChange(of: customer.section) { _, value in UserDefaults.standard.set(value.rawValue, forKey: Self.selectionKey) }
        // Restoring the session and polling belong to the window, not to whichever
        // screen is showing: the content switches from sign-in to the workspace
        // while the restore is still running, and a task on that content would be
        // cancelled with it.
        .background {
            Color.clear.task(id: "\(customer.active):\(customer.selectionKey)") {
                guard customer.active else { return }
                await customer.restore()
                await customer.poll()
            }
        }
    }

    private var sidebar: some View {
        List(selection: Binding<CustomerSection?>(get: { customer.section.destination }, set: { if let value = $0 { ui.select(value) } })) {
            ForEach(CustomerSection.groups) { group in
                Section(group.title) {
                    ForEach(group.sections) { section in
                        Label { Text(section.title) } icon: { Icon(section.icon) }
                            .tag(section).accessibilityIdentifier("nav-" + section.rawValue)
                    }
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { projectMenu.padding(.horizontal, 10).padding(.bottom, 6) }
        .safeAreaInset(edge: .bottom, spacing: 0) { accountMenu.padding(10) }
        .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 320)
    }

    /// The current project; switching and creating projects.
    private var projectMenu: some View {
        Menu {
            Picker("Project", selection: $customer.teamID) {
                ForEach(customer.teams) { Text($0.title).tag($0.id) }
            }.pickerStyle(.inline).labelsHidden()
            Divider()
            Button("New Project…") { ui.newProject() }
        } label: {
            Label { Text(customer.currentTeam?.title ?? "No Project").lineLimit(1) } icon: { Image(systemName: "folder") }
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .help("Switch project").accessibilityLabel("Project: " + (customer.currentTeam?.title ?? "none")).accessibilityIdentifier("switch-project")
    }

    private var accountMenu: some View {
        Menu {
            Button("Plans and Billing") { customer.open("/pricing") }
            Button("Documentation") { customer.open("/docs") }
            SettingsLink { Text("Settings…") }
            Divider()
            Button("Sign Out…") { ui.confirmSignOut() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "person.crop.circle").imageScale(.large)
                VStack(alignment: .leading, spacing: 1) {
                    Text(customer.profile?.text("email") ?? "").lineLimit(1).truncationMode(.middle)
                    Text(customer.isPro ? "Pro plan" : "Free plan").font(Theme.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }.contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain)
        .help("Account").accessibilityIdentifier("nav-account")
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
            List(selection: Binding<PanelSection?>(get: { section }, set: { if let value = $0 { section = value } })) {
                Section {
                    ForEach(PanelSection.allCases) { item in
                        Label { Text(item.rawValue) } icon: { Icon(item.icon) }.tag(item)
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Host.current().localizedName ?? "This Mac").font(Theme.headline).foregroundStyle(.primary).lineLimit(1)
                        HStack(spacing: 5) {
                            StatusDot(active: control.engineRunning, size: 6)
                            Text(control.engineRunning ? "Daemon running" : control.observationDate != nil ? "Existing daemon" : "Daemon stopped")
                        }.font(Theme.caption)
                    }.textCase(nil).padding(.bottom, 6)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Text("Shared by every project on this Mac.").font(Theme.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 280)
        } detail: {
            LocalSectionView(model: control, section: section)
        }
        .navigationTitle(section.rawValue)
        .toolbar { ToolbarItem(placement: .status) { DaemonControl(control: control) } }
        .onChange(of: section) { _, value in UserDefaults.standard.set(value.rawValue, forKey: Self.selectionKey) }
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
                Text(control.engineRunning ? "Daemon Running" : "Daemon Stopped")
                Image(systemName: control.engineRunning ? "stop.fill" : "play.fill").imageScale(.small).foregroundStyle(.secondary)
            }
        }
        .disabled(control.engineBusy || (!control.engineRunning && control.configuration == nil))
        .accessibilityLabel(control.engineRunning ? "Stop the local daemon" : "Start the local daemon")
        .help(control.engineRunning ? "Stop the local daemon" : "Start the local daemon. It runs for every project on this Mac.")
        .alert("Daemon could not start", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK") { failure = nil }
        } message: { Text(failure ?? "") }
    }
}

/// Settings (⌘,): everything that is a preference rather than project data.
struct SettingsView: View {
    @ObservedObject var control: ControlPanelModel
    @ObservedObject var customer: CustomerWorkspaceModel
    @AppStorage(AppAppearance.storageKey) private var appearance = AppAppearance.system
    @State private var confirmSignOut = false
    @State private var confirmDaemonSignOut = false

    var body: some View {
        TabView {
            Tab("General", systemImage: "gearshape") { general }
            Tab("Notifications", systemImage: "bell") { notifications }
            Tab("Accounts", systemImage: "person.crop.circle") { accounts }
            Tab("Connection", systemImage: "network") { connection }
        }
        .frame(width: 520).fixedSize(horizontal: false, vertical: true)
    }

    private var general: some View {
        Form {
            Section("Appearance") {
                Picker("Appearance", selection: $appearance) {
                    ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
                }.pickerStyle(.segmented)
            }
            Section {
                Toggle("Open at Login", isOn: Binding(get: { control.runOnLogin }, set: { _ in control.toggleRunOnLogin() }))
                Toggle("Pause Pulling New Tasks", isOn: Binding(get: { control.pullingPaused }, set: { _ in Task { await control.togglePulling() } }))
                    .disabled(!control.engineRunning)
                LabeledContent("Configuration") {
                    Button("Show in Finder") { control.revealConfiguration() }
                }
            } header: { Text("Local Daemon") } footer: {
                Text("Pausing keeps running tasks going and stops the daemon from picking up new ones.")
            }
        }
        .formStyle(.grouped)
        .onChange(of: appearance) { _, value in value.apply() }
    }

    private var notifications: some View {
        Form {
            Section {
                Toggle("Task Notifications", isOn: Binding(get: { customer.notifications }, set: { value in Task { await customer.setNotifications(value) } }))
            } footer: {
                Text("Notifies you when a task starts, needs your input, finishes or fails while TaskSquad is open.")
            }
        }.formStyle(.grouped)
    }

    private var accounts: some View {
        Form {
            Section {
                if let profile = customer.profile {
                    LabeledContent("Signed in as", value: profile.text("email"))
                    LabeledContent("Plan", value: customer.isPro ? "Pro" : "Free")
                    Button("Plans and Billing") { customer.open("/pricing") }
                    Button("Sign Out…", role: .destructive) { confirmSignOut = true }
                } else {
                    Button(customer.signingIn ? "Signing In…" : "Sign In…") { customer.signIn() }.disabled(customer.signingIn)
                }
            } header: { Text("Workspace") } footer: {
                Text("Your projects, tasks and notes. Independent of the local daemon's account.")
            }
            Section {
                if let email = control.loginEmail {
                    LabeledContent("Signed in as", value: email)
                    Button("Sign Out…", role: .destructive) { confirmDaemonSignOut = true }
                } else {
                    Button("Sign In…") { control.signIn() }
                }
            } header: { Text("Local Daemon") } footer: {
                Text("The account local agents on this Mac run tasks for.")
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Sign out of TaskSquad?", isPresented: $confirmSignOut) {
            Button("Sign Out", role: .destructive) { Task { await customer.signOut() } }
        } message: { Text("Local agents keep running. Sign in again to see your projects.") }
        .confirmationDialog("Sign the daemon out?", isPresented: $confirmDaemonSignOut) {
            Button("Sign Out", role: .destructive) { Task { await control.logout() } }
        } message: { Text("Local agents on this Mac stop receiving tasks until you sign in again.") }
    }

    private var connection: some View {
        VStack(alignment: .trailing, spacing: 0) {
            CustomerConnectionForm(model: customer)
            if customer.profile == nil {
                Button("Save") { Task { await customer.saveConnection() } }.padding([.horizontal, .bottom], 20)
            }
        }
    }
}

extension CustomerEditorRequest {
    @MainActor static func newProject(model: CustomerWorkspaceModel) -> CustomerEditorRequest {
        CustomerEditorRequest(title: "New project", fields: [.init("name", "Project name", required: true)], submitLabel: "Create") { body, _ in
            guard let result = await model.perform(.createProject(values: body)) else { return false }
            await model.connect(); model.teamID = result["id"]?.string ?? model.teamID; return true
        }
    }
}

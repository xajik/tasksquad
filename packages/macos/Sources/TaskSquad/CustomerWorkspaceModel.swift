import AppKit
import Combine
import CryptoKit
import SwiftUI
import TaskSquadCore
import UserNotifications

typealias CustomerSection = WorkspaceSection

extension WorkspaceSection {
    var icon: LucideIcon {
        switch self {
        case .inbox: .inbox; case .notes: .fileText; case .portals: .monitor; case .conveyors: .repeat
        case .planners: .layers; case .supervisor: .shieldAlert; case .skills: .bookOpen; case .subAgents: .bot
        case .commands: .squareTerminal; case .memory: .database; case .analytics: .chartColumn; case .agents: .bot; case .members: .users
        case .settings: .settings
        }
    }
}

@MainActor final class CustomerWorkspaceModel: ObservableObject {
    private(set) var workspace: WorkspaceStore!
    let detailStore = RecordDetailStore()
    private var subscriptions: Set<AnyCancellable> = []
    var section: CustomerSection { get { workspace.section } set { if workspace.section != newValue { workspace.section = newValue; resetSelection() } } }
    var teamID: String { get { workspace.projectID } set { if workspace.projectID != newValue { workspace.projectID = newValue; resetSelection(); taskStatuses = [:]; didSeedNotificationStatuses = false } } }
    var profile: CustomerRecord? { workspace.profile }
    var teams: [CustomerRecord] { workspace.projects }
    var agents: [CustomerRecord] { workspace.agents }
    var records: [CustomerRecord] { workspace.records }
    @Published var selectedID: String? { didSet { if oldValue != selectedID { detailStore.reset() } } }
    var detail: CustomerRecord? { detailStore.detail }
    var messages: [CustomerRecord] { detailStore.messages }
    var comments: [CustomerRecord] { detailStore.comments }
    var related: [CustomerRecord] { detailStore.related }
    var rollups: [CustomerRecord] { workspace.rollups }
    var error: String? { get { workspace.error ?? detailStore.error } set { workspace.error = newValue } }
    var busy: Bool { workspace.busy }
    var loading: Bool { workspace.loading }
    @Published var signingIn = false
    @Published var active = false
    var search: String { get { workspace.search } set { workspace.search = newValue } }
    var statusFilter: String { get { workspace.status } set { workspace.status = newValue } }
    var sourceFilter: String { get { workspace.origin } set { workspace.origin = newValue } }
    var archived: Bool { get { workspace.archived } set { workspace.archived = newValue } }
    var memoryCategory: String { get { workspace.memoryCategory } set { workspace.memoryCategory = newValue } }
    var memoryTag: String { get { workspace.memoryTag } set { workspace.memoryTag = newValue } }
    var rollupPeriod: String { get { workspace.rollupPeriod } set { workspace.rollupPeriod = newValue } }
    var hasMore: Bool { workspace.hasMore }
    @Published var apiURL: String
    @Published var dashboardURL: String
    @Published var firebaseAPIKey: String
    @Published var notifications: Bool
    private let defaults: UserDefaults
    private var authentication: Authentication?
    private var loginTask: Task<Void, Never>?
    private var generation = UUID()
    private var didRestore = false
    private var taskStatuses: [String: String] = [:]
    private var didSeedNotificationStatuses = false
    private var notificationTask: Task<Void, Never>?
    private var notificationRefreshing = false
    private let suppliedAPI: CustomerAPI?

    init(defaults: UserDefaults = .standard, api: CustomerAPI? = nil) {
        self.defaults = defaults; suppliedAPI = api
        apiURL = defaults.string(forKey: "customer.api") ?? "https://api.tasksquad.ai"
        dashboardURL = defaults.string(forKey: "customer.dashboard") ?? "https://tasksquad.ai"
        firebaseAPIKey = defaults.string(forKey: "customer.firebase") ?? ""
        notifications = defaults.bool(forKey: "customer.notifications")
        configureWorkspace()
    }

    var currentTeam: CustomerRecord? { teams.first { $0.id == teamID } }
    var isOwner: Bool { currentTeam?.text("role") == "owner" }
    var isMaintainer: Bool { isOwner || currentTeam?.text("role") == "maintainer" }
    var isPro: Bool { profile?.text("plan") == "pro" }
    var selectionKey: String { "\(generation):\(workspace.context):\(teamID):\(section):\(selectedID ?? ""):\(archived):\(memoryCategory):\(rollupPeriod)" }
    var selected: CustomerRecord? { detail ?? records.first { $0.id == selectedID } }
    var visibleRecords: [CustomerRecord] { workspace.visibleRecords }
    func agentName(_ id: String) -> String { agents.first { $0.id == id }?.title ?? id }
    func teamPath(_ resource: String, id: String? = nil) -> [String] {
        ["teams", teamID, resource] + (id.map { [$0] } ?? [])
    }
    func path(for section: CustomerSection, id: String? = nil, team: String? = nil) -> [String] {
        let base = [.inbox, .supervisor, .portals].contains(section) ? [section.resource] : ["teams", team ?? teamID, section.resource]
        return base + (id.map { [$0] } ?? [])
    }
    private var store: KeychainCredentialStore {
        let scope = SHA256.hash(data: Data(apiURL.utf8)).map { String(format: "%02x", $0) }.joined()
        return KeychainCredentialStore(service: "tasksquad-customer-" + scope)
    }
    private func auth() -> Authentication {
        if let authentication { return authentication }
        let value = Authentication(store: store, apiURL: apiURL, firebaseAPIKey: firebaseAPIKey)
        authentication = value; return value
    }
    func api() throws -> CustomerAPI {
        if let suppliedAPI { return suppliedAPI }
        guard let url = URL(string: apiURL), url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? "")) else {
            throw ConfigurationError("Use an HTTPS API address, or HTTP on localhost for development.")
        }
        let authentication = auth()
        return CustomerAPI(baseURL: url) { try await authentication.token(forceRotation: $0) }
    }
    func restore() async {
        guard !didRestore else { return }; didRestore = true
        guard suppliedAPI == nil else { await connect(); return }
        let store = store
        let saved = await Task.detached { try? store.readWithoutPrompt(.email) }.value
        if saved != nil { await connect() }
    }
    func signIn() {
        guard !signingIn else { return }
        signingIn = true; error = nil
        loginTask = Task {
            defer { signingIn = false; loginTask = nil }
            do {
                guard let url = URL(string: dashboardURL), url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "")) else { throw URLError(.badURL) }
                let flow = try await LoginFlow.begin(dashboardURL: dashboardURL, secureCallback: true)
                guard NSWorkspace.shared.open(flow.browserURL) else { await flow.cancel(); throw ConfigurationError("Could not open the sign-in page.") }
                let callback = try await flow.result()
                // Clear any credentials left by a previous unsuccessful login
                // before minting for the new account; never reuse its CLI token.
                try await auth().logout()
                if !callback.firebaseAPIKey.isEmpty {
                    firebaseAPIKey = callback.firebaseAPIKey; defaults.set(firebaseAPIKey, forKey: "customer.firebase"); authentication = nil
                }
                try await auth().acceptLogin(idToken: callback.idToken, refreshToken: callback.refreshToken, email: callback.email)
                await connect()
            } catch where isCancellation(error) { }
            catch { self.error = error.localizedDescription }
        }
    }
    func cancelLogin() { loginTask?.cancel() }
    private func configureWorkspace() {
        let client = (try? api()) ?? CustomerAPI(baseURL: URL(string: "https://invalid.invalid")!) { _ in throw ConfigurationError("Use a valid API address.") }
        workspace = WorkspaceStore(api: client, preferences: defaults)
        subscriptions.removeAll()
        workspace.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &subscriptions)
        detailStore.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &subscriptions)
    }
    func connect() async {
        do { _ = try api() } catch { self.error = error.localizedDescription; return }
        await workspace.connect(refresh: false)
        if profile != nil { startNotificationMonitor() }
    }
    func signOut() async {
        notificationTask?.cancel(); notificationTask = nil
        cancelLogin(); await loginTask?.value
        generation = UUID(); clearAccount()
        do { try await auth().logout() } catch { self.error = error.localizedDescription }
        authentication = nil
        configureWorkspace()
    }
    func saveConnection() async {
        guard profile == nil, !signingIn else { return }
        authentication = nil
        do { _ = try api() } catch { self.error = error.localizedDescription; return }
        defaults.set(apiURL, forKey: "customer.api"); defaults.set(dashboardURL, forKey: "customer.dashboard")
        defaults.set(firebaseAPIKey, forKey: "customer.firebase")
        generation = UUID(); didRestore = false; clearAccount(); configureWorkspace(); await restore()
    }
    private func clearAccount() { workspace.resetAccount(); resetSelection() }
    private func resetSelection() {
        generation = UUID(); selectedID = nil; detailStore.reset()
    }
    func refresh(loadMore: Bool = false) async {
        guard profile != nil else { return }
        let key = selectionKey, id = selectedID
        await workspace.refresh(loadMore: loadMore)
        guard selectionKey == key, !Task.isCancelled else { return }
        if let id { await detailStore.refresh(workspace: workspace, id: id) }
    }
    @discardableResult func perform(_ operation: WorkspaceOperation) async -> JSONValue? { await workspace.perform(operation) }
    /// Sends the operation and refreshes the workspace and selection on success.
    func run(_ operation: WorkspaceOperation) async { if await perform(operation) != nil { await refresh() } }
    func openTask(_ id: String) { section = .inbox; selectedID = id }
    func open(_ route: String) { if let url = URL(string: dashboardURL + route) { NSWorkspace.shared.open(url) } }
    func openInBrowser() {
        let route: String
        switch section {
        case .inbox, .supervisor: route = selectedID.map { "/dashboard/tasks/" + $0 } ?? "/dashboard"
        case .conveyors: route = "/dashboard/conveyor"
        case .planners: route = "/dashboard/planner" + (selectedID.map { "/" + $0 } ?? "")
        case .subAgents, .commands: route = "/dashboard/skills"
        default: route = "/dashboard/" + section.resource + ([.notes, .portals].contains(section) ? (selectedID.map { "/" + $0 } ?? "") : "")
        }
        if let url = URL(string: dashboardURL + route) { NSWorkspace.shared.open(url) }
    }
    func setNotifications(_ enabled: Bool) async {
        guard Bundle.main.bundleIdentifier != nil else { error = "Notifications require the installed .app."; return }
        do {
            notifications = enabled ? try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) : false
            defaults.set(notifications, forKey: "customer.notifications")
        } catch { self.error = error.localizedDescription }
    }
    private func notifyTransitions(_ tasks: [CustomerRecord]) {
        defer { taskStatuses = Dictionary(tasks.map { ($0.id, $0.status) }, uniquingKeysWith: { _, new in new }) }
        if !didSeedNotificationStatuses { didSeedNotificationStatuses = true; return }
        guard notifications, Bundle.main.bundleIdentifier != nil else { return }
        for task in tasks where taskStatuses[task.id] != nil && taskStatuses[task.id] != task.status {
            guard ["running", "waiting_input", "done", "failed"].contains(task.status) else { continue }
            let content = UNMutableNotificationContent()
            content.title = agentName(task.text("agent_id")) + " · " + task.status.replacingOccurrences(of: "_", with: " ")
            content.body = task.title; content.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: task.id, content: content, trigger: nil))
        }
    }
    private func startNotificationMonitor() {
        notificationTask?.cancel()
        guard suppliedAPI == nil, profile != nil, !teamID.isEmpty else { return }
        notificationTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshNotificationSnapshot()
                guard let self else { return }
                do { try await Task.sleep(for: .seconds(WorkspacePolicy.pollInterval(isPro: self.isPro))) } catch { return }
            }
        }
    }
    private func refreshNotificationSnapshot() async {
        guard profile != nil, !teamID.isEmpty, !notificationRefreshing else { return }
        notificationRefreshing = true; defer { notificationRefreshing = false }
        let team = teamID
        do {
            let snapshot = try CustomerRecord(await api().request(["tasks"], query: ["team_id": team]))
            guard teamID == team, !Task.isCancelled else { return }
            notifyTransitions(snapshot.records("tasks"))
        } catch where isCancellation(error) { }
        catch { /* The view reports interactive failures; background notification polling retries. */ }
    }
    func shutdown() async { generation = UUID(); notificationTask?.cancel(); notificationTask = nil; cancelLogin(); await loginTask?.value }
}

/// Cancellation is routine (a view's `.task` restarting, the user closing the
/// browser sign-in); it must never surface as an error banner.
func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if let error = error as? URLError, error.code == .cancelled { return true }
    return (error as NSError).domain == NSURLErrorDomain && (error as NSError).code == NSURLErrorCancelled
}

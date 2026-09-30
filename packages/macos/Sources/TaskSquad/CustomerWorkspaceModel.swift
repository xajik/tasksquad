import AppKit
import CryptoKit
import SwiftUI
import TaskSquadCore
import UserNotifications

enum CustomerSection: String, CaseIterable, Identifiable {
    case inbox = "Inbox", notes = "Notes", portals = "Portals", conveyors = "Conveyors", planners = "Planners"
    case supervisor = "Supervisor", skills = "Skills", subAgents = "Sub-agents", commands = "Commands"
    case memory = "Memory", agents = "Agents", members = "Members", settings = "Settings"
    var id: String { rawValue }
    var icon: LucideIcon {
        switch self {
        case .inbox: .inbox; case .notes: .fileText; case .portals: .monitor; case .conveyors: .repeat
        case .planners: .layers; case .supervisor: .shieldAlert; case .skills: .bookOpen; case .subAgents: .bot
        case .commands: .squareTerminal; case .memory: .database; case .agents: .bot; case .members: .users
        case .settings: .settings
        }
    }
    var resource: String {
        switch self {
        case .inbox, .supervisor: "tasks"; case .subAgents: "sub-agents"
        default: rawValue.lowercased()
        }
    }
    var envelope: String { self == .subAgents ? "sub_agents" : resource }
    var isLibrary: Bool { [.skills, .subAgents, .commands].contains(self) }
}

@MainActor final class CustomerWorkspaceModel: ObservableObject {
    @Published var section: CustomerSection = .inbox { didSet { if oldValue != section { resetSelection() } } }
    @Published var teamID = "" {
        didSet {
            guard oldValue != teamID else { return }
            defaults.set(teamID, forKey: "customer.team"); agents = []; resetSelection()
        }
    }
    @Published var profile: CustomerRecord?
    @Published var teams: [CustomerRecord] = []
    @Published var agents: [CustomerRecord] = []
    @Published var records: [CustomerRecord] = []
    @Published var selectedID: String? { didSet { if oldValue != selectedID { detail = nil; messages = []; related = []; comments = [] } } }
    @Published var detail: CustomerRecord?
    @Published var messages: [CustomerRecord] = []
    @Published var comments: [CustomerRecord] = []
    @Published var related: [CustomerRecord] = []
    @Published var rollups: [CustomerRecord] = []
    @Published var error: String?
    @Published var busy = false
    @Published var loading = false
    @Published var signingIn = false
    @Published var active = false
    @Published var search = ""
    @Published var statusFilter = "all"
    @Published var sourceFilter = "all"
    @Published var archived = false
    @Published var memoryCategory = "all"
    @Published var memoryTag = ""
    @Published var rollupPeriod = "daily"
    @Published var hasMore = false
    @Published var apiURL: String
    @Published var dashboardURL: String
    @Published var firebaseAPIKey: String
    @Published var notifications: Bool
    private let defaults: UserDefaults
    private var authentication: Authentication?
    private var loginTask: Task<Void, Never>?
    private var generation = UUID()
    private var refreshing = false
    private var didRestore = false
    private var taskStatuses: [String: String] = [:]
    private let suppliedAPI: CustomerAPI?

    init(defaults: UserDefaults = .standard, api: CustomerAPI? = nil) {
        self.defaults = defaults; suppliedAPI = api
        apiURL = defaults.string(forKey: "customer.api") ?? "https://api.tasksquad.ai"
        dashboardURL = defaults.string(forKey: "customer.dashboard") ?? "https://tasksquad.ai"
        firebaseAPIKey = defaults.string(forKey: "customer.firebase") ?? ""
        notifications = defaults.bool(forKey: "customer.notifications")
        teamID = defaults.string(forKey: "customer.team") ?? ""
    }

    var currentTeam: CustomerRecord? { teams.first { $0.id == teamID } }
    var isOwner: Bool { currentTeam?.text("role") == "owner" }
    var isMaintainer: Bool { isOwner || currentTeam?.text("role") == "maintainer" }
    var isPro: Bool { profile?.text("plan") == "pro" }
    var selectionKey: String { "\(generation):\(teamID):\(section):\(selectedID ?? ""):\(archived):\(memoryCategory):\(rollupPeriod)" }
    var selected: CustomerRecord? { detail ?? records.first { $0.id == selectedID } }
    var visibleRecords: [CustomerRecord] {
        records.filter { record in
            (search.isEmpty || [record.title, record.text("body"), record.text("description"), record.text("content"), agentName(record.text("agent_id")), record.strings("tags").joined(separator: " ")].contains { $0.localizedCaseInsensitiveContains(search) })
            && (statusFilter == "all" || record.status == statusFilter)
            && (memoryTag.isEmpty || record.strings("tags").contains(memoryTag))
            && matchesSource(record)
        }
    }
    private func matchesSource(_ record: CustomerRecord) -> Bool {
        guard section == .inbox, sourceFilter != "all" else { return true }
        switch sourceFilter {
        case "mine": return record.text("sender_id") == profile?.id
        case "system": return record.text("first_message_role") == "system"
        case "scheduled": return record.number("scheduled_at") > 0
        case "planner": return !record.text("planner_id").isEmpty
        case "conveyor": return !record.text("conveyor_id").isEmpty
        default: return record.text("first_message_type") == sourceFilter
        }
    }
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
    func connect() async {
        let generation = generation
        loading = true; defer { loading = false }
        do {
            let api = try api()
            async let user = api.request(["me"])
            async let teamList = api.request(["teams"])
            let (u, t) = try await (user, teamList)
            guard self.generation == generation else { return }
            profile = CustomerRecord(u); teams = CustomerRecord(t).records("teams")
            if !teams.contains(where: { $0.id == teamID }) { teamID = teams.first?.id ?? "" }
            error = nil
        } catch where isCancellation(error) { }
        catch { if self.generation == generation { self.error = error.localizedDescription } }
    }
    func signOut() async {
        cancelLogin(); await loginTask?.value
        generation = UUID(); clearAccount()
        do { try await auth().logout() } catch { self.error = error.localizedDescription }
        authentication = nil
    }
    func saveConnection() async {
        guard profile == nil, !signingIn else { return }
        authentication = nil
        do { _ = try api() } catch { self.error = error.localizedDescription; return }
        defaults.set(apiURL, forKey: "customer.api"); defaults.set(dashboardURL, forKey: "customer.dashboard")
        defaults.set(firebaseAPIKey, forKey: "customer.firebase")
        generation = UUID(); didRestore = false; clearAccount(); await restore()
    }
    private func clearAccount() { profile = nil; teams = []; agents = []; resetSelection() }
    private func resetSelection() {
        generation = UUID(); selectedID = nil; records = []; detail = nil; messages = []; comments = []; related = []; rollups = []
        taskStatuses = [:]; search = ""; statusFilter = "all"; sourceFilter = "all"; memoryTag = ""; error = nil
    }
    func refresh(loadMore: Bool = false) async {
        guard !teamID.isEmpty, profile != nil, !refreshing else { return }
        refreshing = true; loading = records.isEmpty
        defer { refreshing = false; loading = false }
        let key = selectionKey, section = section, team = teamID, id = selectedID
        do {
            let api = try api()
            async let agentResponse = api.request(["teams", team, "agents"])
            var query: [String: String] = [:]
            if [.inbox, .supervisor, .portals].contains(section) { query["team_id"] = team }
            if section == .notes { query = ["archived": archived ? "true" : "false", "limit": String(loadMore ? 100 : max(records.count, 100)), "offset": loadMore ? String(records.count) : "0"] }
            if section == .memory, memoryCategory != "all" { query["category"] = memoryCategory }
            var response: JSONValue = section == .settings ? .null : try await api.request(path(for: section, team: team), query: query)
            let agentList = try await agentResponse
            var values = CustomerRecord(response).records(section.envelope)
            // Notes are capped at 100 per response. Refresh every already-loaded
            // page so polling cannot silently collapse a paginated list.
            if section == .notes, !loadMore {
                while values.count < records.count, CustomerRecord(response).flag("has_more"), !values.isEmpty {
                    query["offset"] = String(values.count)
                    response = try await api.request(path(for: section, team: team), query: query)
                    let page = CustomerRecord(response).records("notes")
                    if page.isEmpty { break }
                    values += page
                }
            }
            if section == .supervisor {
                values.sort { lhs, rhs in
                    if (lhs.number("supervisor_report_count") > 0) != (rhs.number("supervisor_report_count") > 0) { return lhs.number("supervisor_report_count") > 0 }
                    return max(lhs.number("last_supervisor_at"), lhs.number("created_at")) > max(rhs.number("last_supervisor_at"), rhs.number("created_at"))
                }
            }
            var fetchedDetail: CustomerRecord?, fetchedMessages: [CustomerRecord] = [], fetchedComments: [CustomerRecord] = [], fetchedRelated: [CustomerRecord] = [], fetchedRollups: [CustomerRecord] = []
            if let id, section != .settings {
                if ![.agents, .members, .conveyors].contains(section) {
                    fetchedDetail = CustomerRecord(try await api.request(path(for: section, id: id, team: team)))
                }
                if [.inbox, .supervisor].contains(section) { fetchedMessages = CustomerRecord(try await api.request(["tasks", id, "messages"])).records("messages") }
                if section == .notes {
                    fetchedComments = CustomerRecord(try await api.request(["teams", team, "notes", id, "comments"])).records("comments")
                    fetchedRelated = CustomerRecord(try await api.request(["teams", team, "notes", id, "tasks"])).records("tasks")
                }
                if section == .conveyors { fetchedRelated = CustomerRecord(try await api.request(["teams", team, "conveyors", id, "tasks"])).records("tasks") }
            }
            if section == .memory { fetchedRollups = CustomerRecord(try await api.request(["teams", team, "rollups"], query: ["period": rollupPeriod])).records("rollups") }
            guard selectionKey == key, !Task.isCancelled else { return }
            agents = CustomerRecord(agentList).records("agents")
            if section == .inbox { notifyTransitions(values) }
            if loadMore {
                let existing = Set(records.map(\.id)); records += values.filter { !existing.contains($0.id) }
            } else { records = values }
            hasMore = CustomerRecord(response).flag("has_more")
            detail = fetchedDetail; messages = fetchedMessages; comments = fetchedComments; related = fetchedRelated; rollups = fetchedRollups
            error = nil
        } catch where isCancellation(error) { }
        catch { if selectionKey == key { self.error = error.localizedDescription } }
    }
    /// Capture the API and full path before starting a mutation. A project switch
    /// can never retarget an already-submitted operation to the new project.
    @discardableResult func mutate(_ path: [String], method: String = "POST", body: [String: JSONValue] = [:], files: [CustomerUpload] = []) async -> JSONValue? {
        guard !busy else { return nil }
        busy = true; let key = generation
        defer { busy = false }
        do {
            let result = try await api().request(path, method: method, body: method == "DELETE" ? nil : .object(body), files: files)
            guard key == generation else { return nil }
            error = nil
            return result
        } catch where isCancellation(error) { return nil }
        catch { if key == generation { self.error = error.localizedDescription }; return nil }
    }
    func perform(_ path: [String], method: String = "POST", body: [String: JSONValue] = [:]) async {
        if await mutate(path, method: method, body: body) != nil { await refresh() }
    }
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
        guard notifications, Bundle.main.bundleIdentifier != nil else { return }
        for task in tasks where taskStatuses[task.id] != nil && taskStatuses[task.id] != task.status {
            guard ["running", "waiting_input", "done", "failed"].contains(task.status) else { continue }
            let content = UNMutableNotificationContent()
            content.title = agentName(task.text("agent_id")) + " · " + task.status.replacingOccurrences(of: "_", with: " ")
            content.body = task.title; content.sound = .default
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: task.id, content: content, trigger: nil))
        }
    }
    func shutdown() async { generation = UUID(); cancelLogin(); await loginTask?.value }
}

/// Cancellation is routine (a view's `.task` restarting, the user closing the
/// browser sign-in); it must never surface as an error banner.
func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if let error = error as? URLError, error.code == .cancelled { return true }
    return (error as NSError).domain == NSURLErrorDomain && (error as NSError).code == NSURLErrorCancelled
}

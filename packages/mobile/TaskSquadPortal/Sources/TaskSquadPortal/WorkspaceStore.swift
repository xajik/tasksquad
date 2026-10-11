import Foundation
import Combine

/// Customer state contains no local execution, AppKit, or credentials. Each response
/// is scoped to the project/section generation that initiated it.
@MainActor public final class WorkspaceStore: ObservableObject {
    @Published public var section: WorkspaceSection = .inbox { didSet { if oldValue != section { reset() } } }
    @Published public var projectID = "" { didSet { if oldValue != projectID { agents = []; reset(); if let key = projectPreferenceKey { preferences?.set(projectID, forKey: key) } } } }
    @Published public private(set) var projects: [CustomerRecord] = []
    @Published public private(set) var profile: CustomerRecord?
    @Published public private(set) var agents: [CustomerRecord] = []
    @Published public private(set) var records: [CustomerRecord] = []
    @Published public private(set) var loading = false
    /// Operation keys (`METHOD path`) currently being sent; drives per-button disabling.
    @Published public private(set) var inFlight: Set<String> = []
    public var busy: Bool { !inFlight.isEmpty }
    @Published public private(set) var refreshedAt: Date?
    @Published public var error: String?
    @Published public var search = ""
    @Published public var status = "all"
    @Published public var origin = "all"
    @Published public var archived = false { didSet { if oldValue != archived { invalidateQuery() } } }
    @Published public var memoryCategory = "all" { didSet { if oldValue != memoryCategory { invalidateQuery() } } }
    @Published public var memoryTag = ""
    @Published public var rollupPeriod = "daily" { didSet { if oldValue != rollupPeriod { invalidateQuery() } } }
    @Published public var analyticsDays = 30 { didSet { if oldValue != analyticsDays { invalidateQuery() } } }
    @Published public var analyticsTimezone = 0 { didSet { if oldValue != analyticsTimezone { invalidateQuery() } } }
    @Published public private(set) var hasMore = false
    @Published public private(set) var rollups: [CustomerRecord] = []
    public let api: CustomerAPI
    private let preferences: UserDefaults?
    private var projectPreferenceKey: String? { profile.map { "mobile.project.\(api.baseURL.absoluteString).\($0.id)" } }
    private var generation = UUID()
    private var refreshID = UUID()
    /// Changes only with the signed-in account; section and filter changes keep it.
    private var accountGeneration = UUID()
    private var mutationScope: String { "\(accountGeneration):\(projectID)" }
    public init(api: CustomerAPI, preferences: UserDefaults? = nil) { self.api = api; self.preferences = preferences }
    public var currentProject: CustomerRecord? { projects.first { $0.id == projectID } }
    public var canManage: Bool { WorkspacePolicy.canManage(role: currentProject?.text("role") ?? "") }
    public var isOwner: Bool { currentProject?.text("role") == "owner" }
    public var isPro: Bool { profile?.text("plan") == "pro" }
    public var eligibleAgents: [CustomerRecord] { agents.filter(WorkspacePolicy.eligible) }
    public var context: String { "\(generation):\(projectID):\(section.rawValue)" }
    public var visibleRecords: [CustomerRecord] {
        records.filter { record in
            (search.isEmpty || [record.title, record.text("body"), record.text("description"), record.text("content"), record.strings("tags").joined(separator: " "), agentName(record.text("agent_id"))].contains { $0.localizedCaseInsensitiveContains(search) }) &&
            (status == "all" || record.status == status) && (memoryTag.isEmpty || record.strings("tags").contains(memoryTag)) && matchesOrigin(record)
        }
    }
    private func matchesOrigin(_ record: CustomerRecord) -> Bool {
        guard section == .inbox else { return true }
        switch origin {
        case "mine": return record.text("sender_id") == profile?.id && record.text("first_message_type") != "note-to-inbox"
        case "scheduled": return record.status == "scheduled" || record.number("scheduled_at") > Date().timeIntervalSince1970 * 1000
        case "planner": return !record.text("planner_id").isEmpty
        case "conveyor": return !record.text("conveyor_id").isEmpty
        case "from-note": return record.text("first_message_type") == "note-to-inbox"
        case "system": return record.text("first_message_role") == "system" && record.text("first_message_type") != "note-to-inbox"
        case "all": return true
        default: return record.text("first_message_type") == origin
        }
    }
    /// Drafts are isolated per API origin, account, project and operation.
    public func draftScope(_ operation: String) -> WorkspaceDraftScope {
        WorkspaceDraftScope(origin: api.baseURL.absoluteString, account: profile?.id ?? "", project: projectID, operation: operation)
    }
    public func agentName(_ id: String) -> String { agents.first { $0.id == id }?.title ?? id }
    public var canCreate: Bool { WorkspacePolicy.canCreate(section: section, project: projectID, role: currentProject?.text("role") ?? "", isPro: isPro, agents: agents, records: records) }
    private func invalidateQuery() { generation = UUID(); refreshID = UUID(); records = []; rollups = []; hasMore = false; loading = false; refreshedAt = nil }
    public func resetAccount() { accountGeneration = UUID(); generation = UUID(); refreshID = UUID(); profile = nil; projects = []; projectID = ""; agents = []; reset() }
    private func reset() { hasMore = false; loading = false; memoryTag = ""; refreshID = UUID(); generation = UUID(); records = []; rollups = []; search = ""; status = "all"; origin = "all"; error = nil; refreshedAt = nil }
    public func path(_ section: WorkspaceSection, id: String? = nil, project: String? = nil) -> [String] {
        WorkspacePolicy.path(section, id: id, project: project ?? projectID)
    }
    public func connect(refresh: Bool = true) async {
        let key = context
        do {
            async let user = api.request(["me"])
            async let teams = api.request(["teams"])
            let (u, t) = try await (user, teams)
            guard context == key, !Task.isCancelled else { return }
            if profile?.id != nil, profile?.id != CustomerRecord(u).id { accountGeneration = UUID(); reset(); projectID = "" }
            profile = CustomerRecord(u); projects = CustomerRecord(t).records("teams")
            if !projects.contains(where: { $0.id == projectID }) {
                let saved = projectPreferenceKey.flatMap { preferences?.string(forKey: $0) }
                projectID = projects.first { $0.id == saved }?.id ?? projects.first?.id ?? ""
            }
            if refresh { await self.refresh() }
        } catch { if context == key { handle(error) } }
    }
    private var pollRefresh: (key: String, task: Task<Void, Never>)?
    /// Explicit refreshes (after a mutation, pull-to-refresh) always send new
    /// requests so they observe the change. `coalesce` is for timer ticks: they
    /// join a refresh already running for the same scope instead of stacking.
    public func refresh(loadMore: Bool = false, coalesce: Bool = false) async {
        if coalesce, !loadMore {
            if let running = pollRefresh, running.key == context { await running.task.value; return }
            let key = context, task = Task { await self.load(loadMore: false) }
            pollRefresh = (key, task)
            await task.value
            if pollRefresh?.key == key { pollRefresh = nil }
            return
        }
        await load(loadMore: loadMore)
    }
    private func load(loadMore: Bool) async {
        guard !projectID.isEmpty else { return }
        let key = context, team = projectID, section = section, requestID = UUID(), loadedCount = records.count
        refreshID = requestID; loading = records.isEmpty
        defer { if refreshID == requestID { loading = false } }
        do {
            async let agents = api.request(["teams", team, "agents"])
            var query: [String: String] = [:]
            if [.inbox, .supervisor, .portals].contains(section) { query["team_id"] = team }
            if section == .memory, memoryCategory != "all" { query["category"] = memoryCategory }
            if section == .notes { query = ["archived": archived ? "true" : "false", "limit": "100", "offset": loadMore ? String(loadedCount) : "0"] }
            var response: JSONValue
            if section == .settings { response = .null }
            else if section == .analytics {
                response = try await api.request(["teams", team, "stats"], query: ["from": String(Int(Date().addingTimeInterval(-Double(analyticsDays)*86400).timeIntervalSince1970*1000)), "to": String(Int(Date().timeIntervalSince1970*1000)), "tz": String(analyticsTimezone)])
            } else { response = try await api.request(path(section, project: team), query: query) }
            let nextRollups = section == .memory ? CustomerRecord(try await api.request(["teams", team, "rollups"], query: ["period": rollupPeriod])).records("rollups") : []
            var values = section == .analytics ? [CustomerRecord(response)] : CustomerRecord(response).records(section.envelope)
            if section == .notes, !loadMore {
                while values.count < loadedCount, CustomerRecord(response).flag("has_more"), !values.isEmpty {
                    try Task.checkCancellation()
                    guard key == context, refreshID == requestID else { return }
                    query["offset"] = String(values.count)
                    response = try await api.request(path(section, project: team), query: query)
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
            let agentResponse = try await agents
            guard key == context, refreshID == requestID, !Task.isCancelled else { return }
            self.agents = CustomerRecord(agentResponse).records("agents")
            if loadMore {
                var seen = Set(records.map(\.id))
                records += values.filter { seen.insert($0.id).inserted }
            } else { records = values }
            hasMore = CustomerRecord(response).flag("has_more")
            rollups = nextRollups
            refreshedAt = Date(); error = nil
        } catch { if key == context, refreshID == requestID { handle(error) } }
    }
    nonisolated public static func operationKey(_ path: [String], method: String) -> String { method + " " + path.joined(separator: "/") }
    public func isRunning(_ path: [String], method: String = "POST") -> Bool { inFlight.contains(Self.operationKey(path, method: method)) }
    /// A result is returned whenever the server accepted the change for the same
    /// account and project, even if the section, filters or calling view changed
    /// meanwhile; dropping it would make callers keep a sent draft and resubmit.
    /// Only an identical operation already in flight is suppressed.
    @discardableResult public func mutate(_ path: [String], method: String = "POST", body: [String: JSONValue] = [:], files: [CustomerUpload] = []) async -> JSONValue? {
        let key = Self.operationKey(path, method: method)
        guard !inFlight.contains(key) else { return nil }
        inFlight.insert(key); let scope = mutationScope
        defer { inFlight.remove(key) }
        do {
            let result = try await api.request(path, method: method, body: method == "DELETE" ? nil : .object(body), files: files)
            guard scope == mutationScope else { return nil }
            error = nil; return result
        } catch { if scope == mutationScope { handle(error) }; return nil }
    }
    /// The single polling driver for both apps (2 s Pro, 5 s otherwise). The
    /// caller's lifecycle task owns cancellation; there is no detached timer.
    /// `onTick` chains dependent work such as the open record's detail; pass
    /// `refreshWorkspace: false` when only that dependent work should run.
    public func poll(refreshWorkspace: Bool = true, onTick: (@MainActor () async -> Void)? = nil) async {
        while !Task.isCancelled {
            if refreshWorkspace { await refresh(coalesce: true) }
            if !Task.isCancelled { await onTick?() }
            do { try await Task.sleep(for: .seconds(WorkspacePolicy.pollInterval(isPro: isPro))) } catch { return }
        }
    }
    @discardableResult public func perform(_ operation: WorkspaceOperation) async -> JSONValue? {
        await mutate(operation.path, method: operation.method, body: operation.body, files: operation.files)
    }
    public func isRunning(_ operation: WorkspaceOperation) -> Bool { inFlight.contains(operation.key) }
    @discardableResult public func create(section: WorkspaceSection, project: String, values: [String: JSONValue], files: [CustomerUpload] = []) async -> JSONValue? {
        guard project == projectID else { return nil }
        return await perform(.create(section, project: project, values: values, files: files))
    }
    public func handle(_ failure: Error) {
        guard !(failure is CancellationError), (failure as? URLError)?.code != .cancelled else { return }
        error = failure.localizedDescription
    }
}

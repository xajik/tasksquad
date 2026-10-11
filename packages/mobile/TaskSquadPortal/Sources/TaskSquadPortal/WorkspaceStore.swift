import Foundation
import Combine

/// Customer state contains no local execution, AppKit, or credentials. Each response
/// is scoped to the project/section generation that initiated it.
@MainActor public final class WorkspaceStore: ObservableObject {
    @Published public var section: WorkspaceSection = .inbox { didSet { if oldValue != section { reset() } } }
    @Published public var projectID = "" { didSet { if oldValue != projectID { agents = []; reset() } } }
    @Published public private(set) var projects: [CustomerRecord] = []
    @Published public private(set) var profile: CustomerRecord?
    @Published public private(set) var agents: [CustomerRecord] = []
    @Published public private(set) var records: [CustomerRecord] = []
    @Published public private(set) var loading = false
    @Published public private(set) var busy = false
    @Published public private(set) var refreshedAt: Date?
    @Published public var error: String?
    @Published public var search = ""
    @Published public var status = "all"
    @Published public var origin = "all"
    @Published public var archived = false
    public let api: CustomerAPI
    private var generation = UUID()
    private var refreshID = UUID()
    public init(api: CustomerAPI) { self.api = api }
    public var currentProject: CustomerRecord? { projects.first { $0.id == projectID } }
    public var canManage: Bool { ["owner", "maintainer"].contains(currentProject?.text("role") ?? "") }
    public var isOwner: Bool { currentProject?.text("role") == "owner" }
    public var isPro: Bool { profile?.text("plan") == "pro" }
    public var eligibleAgents: [CustomerRecord] { agents.filter { !$0.flag("paused") && ["active", "idle"].contains($0.status) } }
    public var context: String { "\(generation):\(projectID):\(section.rawValue)" }
    public var visibleRecords: [CustomerRecord] {
        records.filter { record in
            (search.isEmpty || [record.title, record.text("body"), record.text("description"), record.text("content"), agentName(record.text("agent_id"))].contains { $0.localizedCaseInsensitiveContains(search) }) &&
            (status == "all" || record.status == status) && matchesOrigin(record)
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
        default: return true
        }
    }
    public func agentName(_ id: String) -> String { agents.first { $0.id == id }?.title ?? id }
    private func reset() { generation = UUID(); records = []; search = ""; status = "all"; origin = "all"; error = nil; refreshedAt = nil }
    public func path(_ section: WorkspaceSection, id: String? = nil, project: String? = nil) -> [String] {
        let root = [.inbox, .supervisor, .portals].contains(section) ? [section.resource] : ["teams", project ?? projectID, section.resource]
        return root + (id.map { [$0] } ?? [])
    }
    public func connect() async {
        let key = context
        do {
            async let user = api.request(["me"])
            async let teams = api.request(["teams"])
            let (u, t) = try await (user, teams)
            guard context == key, !Task.isCancelled else { return }
            profile = CustomerRecord(u); projects = CustomerRecord(t).records("teams")
            if !projects.contains(where: { $0.id == projectID }) { projectID = projects.first?.id ?? "" }
            await refresh()
        } catch { if context == key { handle(error) } }
    }
    public func refresh() async {
        guard !projectID.isEmpty else { return }
        let key = context, team = projectID, section = section, requestID = UUID()
        refreshID = requestID; loading = records.isEmpty
        defer { if refreshID == requestID { loading = false } }
        do {
            async let agents = api.request(["teams", team, "agents"])
            var query: [String: String] = [:]
            if [.inbox, .supervisor, .portals].contains(section) { query["team_id"] = team }
            if section == .notes { query = ["archived": archived ? "true" : "false", "limit": "100"] }
            let response: JSONValue
            if section == .settings { response = .null }
            else if section == .analytics {
                response = try await api.request(["teams", team, "stats"], query: ["from": String(Int(Date().addingTimeInterval(-30*86400).timeIntervalSince1970*1000)), "to": String(Int(Date().timeIntervalSince1970*1000)), "tz": "0"])
            } else { response = try await api.request(path(section, project: team), query: query) }
            let agentResponse = try await agents
            guard key == context, refreshID == requestID, !Task.isCancelled else { return }
            self.agents = CustomerRecord(agentResponse).records("agents")
            records = section == .analytics ? [CustomerRecord(response)] : CustomerRecord(response).records(section.envelope)
            refreshedAt = Date(); error = nil
        } catch { if key == context, refreshID == requestID { handle(error) } }
    }
    @discardableResult public func mutate(_ path: [String], method: String = "POST", body: [String: JSONValue] = [:], files: [CustomerUpload] = []) async -> JSONValue? {
        guard !busy else { return nil }
        busy = true; let key = context
        defer { busy = false }
        do {
            let result = try await api.request(path, method: method, body: method == "DELETE" ? nil : .object(body), files: files)
            guard key == context, !Task.isCancelled else { return nil }
            error = nil; return result
        } catch { if key == context { handle(error) }; return nil }
    }
    public func handle(_ failure: Error) {
        guard !(failure is CancellationError), (failure as? URLError)?.code != .cancelled else { return }
        error = failure.localizedDescription
    }
}

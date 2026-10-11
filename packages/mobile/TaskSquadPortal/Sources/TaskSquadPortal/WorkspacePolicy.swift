import Foundation

public enum WorkspacePolicy {
    public static func pollInterval(isPro: Bool) -> Double { isPro ? 2 : 5 }
    public static func canManage(role: String) -> Bool { ["owner", "maintainer"].contains(role) }
    public static func eligible(_ agent: CustomerRecord) -> Bool { !agent.flag("paused") && ["active", "idle"].contains(agent.status) }
    public static func canCreate(section: WorkspaceSection, project: String, role: String, isPro: Bool, agents: [CustomerRecord], records: [CustomerRecord]) -> Bool {
        guard !project.isEmpty else { return false }
        if [.inbox, .notes].contains(section) { return true }
        if section == .portals { return isPro && agents.contains(where: eligible) && records.filter { ["pending", "running"].contains($0.status) }.count < 3 }
        if section == .members { return role == "owner" }
        return canManage(role: role) && ![.supervisor, .memory, .analytics, .settings].contains(section)
    }
    public static func createPayload(_ values: [String: JSONValue], section: WorkspaceSection, project: String) -> [String: JSONValue] {
        var body = values
        if [.inbox, .portals].contains(section) { body["team_id"] = .string(project) }
        if section == .inbox {
            body["save_tokens"] = .object(["enabled": body.removeValue(forKey: "save_tokens_enabled") ?? .bool(false), "level": body.removeValue(forKey: "save_tokens_level") ?? .string("full")])
        }
        return body
    }
}

public struct StatusPresentation: Equatable, Sendable {
    public enum Variant: Sendable { case `default`, secondary, destructive, outline }
    public let label: String
    public let variant: Variant
    public init(_ status: String) {
        label = status == "waiting_input" ? "Waiting for input" : status.replacingOccurrences(of: "_", with: " ").prefix(1).uppercased() + status.replacingOccurrences(of: "_", with: " ").dropFirst()
        switch status {
        case "running", "done", "idle", "live", "accumulating": variant = .default
        case "queued", "waiting_input", "scheduled", "stuck", "wrapping_up": variant = .secondary
        case "failed", "error": variant = .destructive
        default: variant = .outline
        }
    }
}

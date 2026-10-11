import Foundation

public enum WorkspaceSection: String, CaseIterable, Identifiable {
    case inbox = "Inbox", notes = "Notes", portals = "Portals", conveyors = "Conveyors", planners = "Planners"
    case supervisor = "Supervisor", skills = "Skills", subAgents = "Sub-agents", commands = "Commands"
    case memory = "Memory", analytics = "Analytics", agents = "Agents", members = "Members", settings = "Settings"
    public var id: String { rawValue }
    public var resource: String {
        switch self {
        case .inbox, .supervisor: "tasks"; case .subAgents: "sub-agents"
        default: rawValue.lowercased()
        }
    }
    public var envelope: String { self == .subAgents ? "sub_agents" : resource }
    public var isLibrary: Bool { [.skills, .subAgents, .commands].contains(self) }
}


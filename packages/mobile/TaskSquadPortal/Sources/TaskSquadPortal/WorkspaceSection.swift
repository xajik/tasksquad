import Foundation

public enum WorkspaceSection: String, CaseIterable, Identifiable, Sendable {
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

/// How a section is named, drawn and grouped. One definition for the macOS
/// sidebar, the iPad sidebar and the iPhone tab bar.
public extension WorkspaceSection {
    /// A titled group of destinations in a sidebar.
    struct Group: Identifiable, Sendable {
        public let title: String
        public let sections: [WorkspaceSection]
        public var id: String { title }
    }
    /// Sidebar order. The three libraries share one destination (`.skills`).
    static let groups: [Group] = [
        .init(title: "Work", sections: [.inbox, .notes, .portals]),
        .init(title: "Automation", sections: [.conveyors, .planners, .supervisor]),
        .init(title: "Resources", sections: [.skills, .memory]),
        .init(title: "Manage", sections: [.agents, .members, .analytics, .settings]),
    ]
    /// Every sidebar destination, in order.
    static let destinations: [WorkspaceSection] = groups.flatMap(\.sections)
    /// The iPhone tab bar; everything else is under "More".
    static let tabs: [WorkspaceSection] = [.inbox, .notes, .portals, .agents]
    static let libraries: [WorkspaceSection] = [.skills, .subAgents, .commands]

    /// The sidebar destination that shows this section.
    var destination: WorkspaceSection { isLibrary ? .skills : self }
    /// Name of the destination in a sidebar, tab bar or window title.
    var title: String {
        switch self {
        case .conveyors: "Conveyor"
        case .planners: "Planner"
        case .skills, .subAgents, .commands: "Library"
        case .settings: "Project Settings"
        default: rawValue
        }
    }
    /// Singular, lowercase name of one record: "New task", "Delete note".
    var itemName: String {
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
    /// Lucide icon file name in `TaskSquadDesign`.
    var iconName: String {
        switch self {
        case .inbox: "inbox"
        case .notes: "file-text"
        case .portals: "monitor"
        case .conveyors: "repeat"
        case .planners: "layers"
        case .supervisor: "shield-alert"
        case .skills: "book-open"
        case .subAgents: "bot"
        case .commands: "square-terminal"
        case .memory: "database"
        case .analytics: "chart-column"
        case .agents: "bot"
        case .members: "users"
        case .settings: "settings"
        }
    }
    /// Keyboard digit for the destination (⌘1…⌘9), if it has one.
    var shortcutDigit: Int? { Self.destinations.firstIndex(of: destination).flatMap { $0 < 9 ? $0 + 1 : nil } }
}

/// The values a list can be filtered by, with their labels.
public enum WorkspaceFilter {
    public static let statuses = ["all", "pending", "queued", "running", "waiting_input", "wrapping_up", "scheduled", "done", "failed"]
    public static let origins = ["all", "mine", "system", "scheduled", "planner", "conveyor", "from-note", "note-critique"]
    public static let memoryCategories = ["all", "personal", "preferences", "structure", "architecture", "events"]
    public static func label(_ value: String, any: String) -> String {
        if value == "all" { return any }
        switch value {
        case "mine": return "Created by me"
        case "from-note": return "From a note"
        case "note-critique": return "Note critique"
        default: return StatusPresentation(value).label
        }
    }
}

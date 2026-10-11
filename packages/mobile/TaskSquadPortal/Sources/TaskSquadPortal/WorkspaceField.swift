import Foundation

public struct WorkspaceField: Identifiable {
    public enum Kind { case text, multiline, bool, integer, optionalInteger, date, tags, choice([String]), agent, subAgent }
    public let id: String
    public let label: String
    public var kind: Kind = .text
    public var required = false
    public var initial: JSONValue = .string("")
    public init(_ id: String, _ label: String, _ kind: Kind = .text, required: Bool = false, initial: JSONValue = .string("")) {
        self.id = id; self.label = label; self.kind = kind; self.required = required; self.initial = initial
    }
}

extension WorkspaceField {
    public static func fields(for section: WorkspaceSection, record: CustomerRecord? = nil) -> [WorkspaceField] {
        let fields: [WorkspaceField]
        switch section {
        case .inbox:
            fields = [.init("subject", "Subject", required: true), .init("agent_id", "Agent", .agent, required: true),
                .init("body", "Message", .multiline), .init("scheduled_at", "Schedule task", .date, initial: .null),
                .init("auto_close", "Auto-close after completion", .bool, initial: .bool(false)),
                .init("save_tokens_enabled", "Save tokens", .bool, initial: .bool(false)),
                .init("save_tokens_level", "Token saving level", .choice(["lite", "full", "ultra"]), initial: .string("full")),
                .init("close_steps", "Close steps (blank uses defaults)", .tags, initial: .array([]))]
        case .notes:
            fields = [.init("title", "Title", required: true), .init("content", "Content", .multiline), .init("tags", "Tags", .tags, initial: .array([]))]
        case .skills, .subAgents, .commands:
            fields = [.init("name", "Name", required: true), .init("description", "Description"), .init("content", "Content", .multiline, required: true), .init("auto_install", "Install automatically", .bool, initial: .bool(false))]
        case .agents:
            fields = [.init("name", "Name", required: true), .init("role", "Role and instructions", .multiline)]
        case .members: fields = [.init("email", "Email", required: true)]
        case .portals: fields = [.init("agent_id", "Agent", .agent, required: true)]
        case .conveyors:
            fields = [.init("subject", "Subject", required: true), .init("agent_id", "Agent", .agent, required: true), .init("body", "Message", .multiline, required: true),
                .init("frequency", "Repeat", .choice(["hourly", "daily", "weekly", "monthly"]), initial: .string("daily")),
                .init("hour", "Hour (0–23)", .integer, initial: .number(9)), .init("minute", "Minute (0–59)", .integer, initial: .number(0)),
                .init("day_of_week", "Weekday (0 = Sunday, 6 = Saturday)", .optionalInteger, initial: .number(1)),
                .init("day_of_month", "Day of month (1–31)", .optionalInteger, initial: .number(1)),
                .init("timezone", "Time zone", required: true, initial: .string(TimeZone.current.identifier)),
                .init("repeat_count", "Maximum runs (blank = unlimited)", .optionalInteger, initial: .null),
                .init("end_date", "End date", .date, initial: .null), .init("auto_close", "Auto-close tasks", .bool, initial: .bool(false))]
        case .planners:
            fields = [.init("name", "Name", required: true), .init("description", "Description", .multiline),
                .init("max_retries", "Default retries", .integer, initial: .number(3)), .init("auto_close", "Auto-close tasks", .bool, initial: .bool(true)),
                .init("default_sub_agent_id", "Default sub-agent", .subAgent), .init("default_harness_agent_id", "Default harness agent", .agent)]
        default: fields = []
        }
        guard let record else { return fields }
        return fields.map { field in
            var field = field
            if let value = record.value[field.id] { field.initial = value }
            return field
        }
    }
}

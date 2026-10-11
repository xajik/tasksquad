import Foundation

public struct WorkspaceValidationError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}
public struct PhaseDraft: Identifiable, Codable, Equatable, Sendable {
    public var id = UUID()
    public var name = "", agent = "", subAgent = ""
    public var retries = 3
    public var autoClose = true
    public init() {}
}
public enum WorkspaceEditor {
    public static func validateAttachments(_ files: [CustomerUpload]) throws {
        guard files.count <= 5, files.allSatisfy({ $0.data.count <= 10 * 1024 * 1024 && ["image/png", "image/jpeg", "image/gif", "image/webp"].contains($0.mimeType) }) else {
            throw WorkspaceValidationError("Attach up to five PNG, JPEG, GIF or WebP images, each no larger than 10 MiB.")
        }
    }
    public static func payload(fields: [WorkspaceField], values: [String: JSONValue], phases: [PhaseDraft]? = nil, files: [CustomerUpload] = []) throws -> [String: JSONValue] {
        try validateAttachments(files)
        var body = values
        for field in fields {
            if field.required, (body[field.id]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, body[field.id]?.number == nil { throw WorkspaceValidationError("\(field.label) is required.") }
            switch field.kind {
            case .integer, .optionalInteger:
                let text = body[field.id]?.string ?? body[field.id]?.number.map { String(Int($0)) } ?? ""
                if text.isEmpty, case .optionalInteger = field.kind { body[field.id] = .null; continue }
                guard let number = Int(text) else { throw WorkspaceValidationError("\(field.label) must be a whole number.") }
                body[field.id] = .number(Double(number))
            case .date: if let date = body[field.id]?.number, date <= Date().timeIntervalSince1970*1000 { throw WorkspaceValidationError("\(field.label) must be in the future.") }
            default: break
            }
        }
        if let phases {
            guard phases.allSatisfy({ !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { throw WorkspaceValidationError("Give every phase a name.") }
            body["phases"] = .array(phases.map { phase in
                var fields: [String: JSONValue] = ["name": .string(phase.name), "max_retries": .number(Double(phase.retries)), "auto_close": .bool(phase.autoClose)]
                if !phase.agent.isEmpty { fields["harness_agent_id"] = .string(phase.agent) }
                if !phase.subAgent.isEmpty { fields["sub_agent_id"] = .string(phase.subAgent) }
                return .object(fields)
            })
            for key in ["default_sub_agent_id", "default_harness_agent_id"] where body[key] == .string("") { body.removeValue(forKey: key) }
        }
        for (key, range) in [("hour", 0...23), ("minute", 0...59), ("day_of_week", 0...6), ("day_of_month", 1...31)] {
            if let value = body[key]?.number, !range.contains(Int(value)) { throw WorkspaceValidationError("\(key.replacingOccurrences(of: "_", with: " ")) must be between \(range.lowerBound) and \(range.upperBound).") }
        }
        if let zone = body["timezone"]?.string, TimeZone(identifier: zone) == nil { throw WorkspaceValidationError("Choose a valid time zone.") }
        if let count = body["repeat_count"]?.number, count < 1 { throw WorkspaceValidationError("Maximum runs must be at least 1.") }
        if let retries = body["max_retries"]?.number, !(0...10).contains(retries) { throw WorkspaceValidationError("Retries must be between 0 and 10.") }
        if let phases, phases.isEmpty || phases.contains(where: { !(0...10).contains($0.retries) }) { throw WorkspaceValidationError("Add a phase with retries between 0 and 10.") }
        return body
    }
}

/// Scope is encoded as a tuple so IDs containing delimiters cannot collide.
public struct WorkspaceDraftScope: Codable, Sendable {
    public let origin: String, account: String, project: String, operation: String
    public init(origin: String, account: String, project: String, operation: String) { self.origin = origin; self.account = account; self.project = project; self.operation = operation }
    public var key: String { (try? JSONEncoder().encode([origin, account, project, operation]).base64EncodedString()) ?? "" }
}
@MainActor public struct WorkspaceDraftStore {
    private let defaults: UserDefaults
    private let prefix: String
    public init(defaults: UserDefaults = .standard, prefix: String = "workspace.draft.") { self.defaults = defaults; self.prefix = prefix }
    public func load(_ scope: WorkspaceDraftScope) -> [String: JSONValue]? { load(scope.key) }
    public func save(_ values: [String: JSONValue], scope: WorkspaceDraftScope) { save(values, key: scope.key) }
    public func remove(_ scope: WorkspaceDraftScope) { remove(scope.key) }
    public func load(_ key: String) -> [String: JSONValue]? {
        guard let data = defaults.data(forKey: prefix + key) else { return nil }
        return try? JSONDecoder().decode([String: JSONValue].self, from: data)
    }
    public func save(_ values: [String: JSONValue], key: String) { defaults.set(try? JSONEncoder().encode(values), forKey: prefix + key) }
    public func remove(_ key: String) { defaults.removeObject(forKey: prefix + key) }
    public func clear() { for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(prefix) { defaults.removeObject(forKey: key) } }
}

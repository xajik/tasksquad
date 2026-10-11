import Foundation
import TaskSquadPortal

@MainActor enum MobileDraftStore {
    private static var defaults: UserDefaults {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-api") || ProcessInfo.processInfo.arguments.contains("--ui-test-auth") { return UserDefaults(suiteName: "ai.tasksquad.fixture-drafts")! }
        #endif
        return .standard
    }
    private static let prefix = "mobile.draft."
    static func load(_ key: String) -> [String: JSONValue]? {
        guard let data = defaults.data(forKey: prefix + key) else { return nil }
        return try? JSONDecoder().decode([String: JSONValue].self, from: data)
    }
    static func save(_ value: [String: JSONValue], key: String) {
        defaults.set(try? JSONEncoder().encode(value), forKey: prefix + key)
    }
    static func remove(_ key: String) { defaults.removeObject(forKey: prefix + key) }
    static func clear() { for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(prefix) { defaults.removeObject(forKey: key) } }
}

import Foundation
import TaskSquadPortal

@MainActor enum MobileDraftStore {
    private static let prefix = "mobile.draft."
    static func load(_ key: String) -> [String: JSONValue]? {
        guard let data = UserDefaults.standard.data(forKey: prefix + key) else { return nil }
        return try? JSONDecoder().decode([String: JSONValue].self, from: data)
    }
    static func save(_ value: [String: JSONValue], key: String) {
        UserDefaults.standard.set(try? JSONEncoder().encode(value), forKey: prefix + key)
    }
    static func remove(_ key: String) { UserDefaults.standard.removeObject(forKey: prefix + key) }
    static func clear() { for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix(prefix) { UserDefaults.standard.removeObject(forKey: key) } }
}

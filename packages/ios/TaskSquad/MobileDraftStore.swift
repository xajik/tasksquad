import Foundation
import TaskSquadPortal

@MainActor enum MobileDraftStore {
    private static var defaults: UserDefaults {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-api") || ProcessInfo.processInfo.arguments.contains("--ui-test-auth") { return UserDefaults(suiteName: "ai.tasksquad.fixture-drafts")! }
        #endif
        return .standard
    }
    private static var store: WorkspaceDraftStore { WorkspaceDraftStore(defaults: defaults, prefix: "mobile.draft.") }
    static func load(_ key: String) -> [String: JSONValue]? { store.load(key) }
    static func save(_ value: [String: JSONValue], key: String) { store.save(value, key: key) }
    static func remove(_ key: String) { store.remove(key) }
    static func clear() { store.clear() }
}

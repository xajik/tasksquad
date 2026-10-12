import Foundation

/// Run-on-login registration (Go: packages/daemon/autostart, one file per OS).
public protocol Autostart: Sendable {
    var isEnabled: Bool { get }
    func enable(executable: String) throws
    func disable() throws
}

public extension Autostart {
    /// Go enables run-on-boot once, on the first daemon start, recording `config.toml.autostart-set`.
    /// Returns false when an earlier run already did, so a later opt-out sticks.
    @discardableResult
    func enableOnFirstRun(executable: String, paths: TaskSquadPaths) throws -> Bool {
        let marker = URL(fileURLWithPath: paths.config.path + ".autostart-set")
        guard !FileManager.default.fileExists(atPath: marker.path) else { return false }
        try enable(executable: executable)
        try paths.createRoot()
        try Data().write(to: marker)
        return true
    }
}

/// Keeps the machine awake while the daemon runs (Go: ui/power_*.go).
public protocol WakeLock: AnyObject, Sendable {
    var isHeld: Bool { get }
    func acquire()
    func release()
}

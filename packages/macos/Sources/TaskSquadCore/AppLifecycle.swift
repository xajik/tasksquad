import Foundation

/// Run-on-login registration (Go: autostart/autostart_darwin.go). Same label,
/// plist and location as the Go daemon, so whichever app last enabled it owns it.
public struct LaunchAgent: Sendable {
    public static let label = "ai.tasksquad.tsq"
    public let home: URL
    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) { self.home = home }

    public var plistURL: URL { home.appendingPathComponent("Library/LaunchAgents/\(Self.label).plist") }
    public var isEnabled: Bool { FileManager.default.fileExists(atPath: plistURL.path) }

    /// Go's xml.EscapeText.
    static func xmlEscape(_ s: String) -> String {
        var out = ""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "&#34;"
            case "'": out += "&#39;"
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\t": out += "&#x9;"
            case "\n": out += "&#xA;"
            case "\r": out += "&#xD;"
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    public func plist(executable: String) -> String {
        let log = home.appendingPathComponent(".tasksquad/logs/launchd.log").path
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
        \t<key>Label</key>
        \t<string>\(Self.label)</string>
        \t<key>ProgramArguments</key>
        \t<array>
        \t\t<string>\(Self.xmlEscape(executable))</string>
        \t</array>
        \t<key>RunAtLoad</key>
        \t<true/>
        \t<key>KeepAlive</key>
        \t<false/>
        \t<key>StandardOutPath</key>
        \t<string>\(Self.xmlEscape(log))</string>
        \t<key>StandardErrorPath</key>
        \t<string>\(Self.xmlEscape(log))</string>
        </dict>
        </plist>

        """
    }

    /// Registers the next login only; loading the job now would start a second daemon.
    public func enable(executable: String) throws {
        try FileManager.default.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".tasksquad/logs"), withIntermediateDirectories: true)
        try Data(plist(executable: executable).utf8).write(to: plistURL)
    }

    /// Removes the registration; unloading would kill this process if launchd started it.
    public func disable() throws {
        do { try FileManager.default.removeItem(at: plistURL) }
        catch let error as CocoaError where error.code == .fileNoSuchFile {}
    }

    /// Go enables run-on-boot once, on the first daemon start, recording `config.toml.autostart-set`.
    /// Returns false when an earlier run already did.
    @discardableResult
    public func enableOnFirstRun(executable: String, paths: TaskSquadPaths) throws -> Bool {
        let marker = URL(fileURLWithPath: paths.config.path + ".autostart-set")
        guard !FileManager.default.fileExists(atPath: marker.path) else { return false }
        try enable(executable: executable)
        try paths.createRoot()
        try Data().write(to: marker)
        return true
    }
}

/// Keeps the Mac awake while pulling is active (Go: ui/power_darwin.go `caffeinate -i`).
public final class WakeLock: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    public init() {}
    public var isHeld: Bool { lock.lock(); defer { lock.unlock() }; return process?.isRunning == true }

    public func acquire() {
        lock.lock(); defer { lock.unlock() }
        guard process?.isRunning != true else { return }
        let caffeinate = Process()
        caffeinate.executableURL = URL(fileURLWithPath: "/usr/bin/caffeinate")
        caffeinate.arguments = ["-i", "-w", String(ProcessInfo.processInfo.processIdentifier)] // also ends if we crash
        do { try caffeinate.run(); process = caffeinate } catch { NSLog("[ui] wakelock: caffeinate failed: %@", error.localizedDescription) }
    }

    public func release() {
        lock.lock(); defer { lock.unlock() }
        if process?.isRunning == true { process?.terminate() }
        process = nil
    }
    deinit { release() }
}

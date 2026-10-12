import Foundation
import TaskSquadCore

/// Run-on-login registration (Go: autostart/autostart_linux.go): an XDG autostart
/// entry the desktop session manager launches. Same path and contents as Go, so
/// whichever daemon last enabled it owns it.
public struct XDGAutostart: Autostart {
    public let home: URL
    private let environment: [String: String]
    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.home = home; self.environment = environment
    }

    /// $XDG_CONFIG_HOME/autostart/tsq.desktop, else ~/.config/autostart/tsq.desktop.
    public var desktopURL: URL {
        let configured = environment["XDG_CONFIG_HOME"] ?? ""
        let config = configured.isEmpty ? home.appendingPathComponent(".config") : URL(fileURLWithPath: configured)
        return config.appendingPathComponent("autostart/tsq.desktop")
    }

    public var isEnabled: Bool { FileManager.default.fileExists(atPath: desktopURL.path) }

    /// Go's text/template output (no escaping: Exec is written verbatim).
    public func desktopEntry(executable: String) -> String {
        """
        [Desktop Entry]
        Type=Application
        Name=TaskSquad Daemon
        Comment=TaskSquad AI agent daemon
        Exec=\(executable)
        Hidden=false
        NoDisplay=false
        X-GNOME-Autostart-enabled=true

        """
    }

    public func enable(executable: String) throws {
        try FileManager.default.createDirectory(at: desktopURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(desktopEntry(executable: executable).utf8).write(to: desktopURL)
    }

    public func disable() throws {
        guard FileManager.default.fileExists(atPath: desktopURL.path) else { return }
        try FileManager.default.removeItem(at: desktopURL)
    }
}

/// Go ui/power_linux.go: a `systemd-inhibit … sleep infinity` child held while pulling.
public final class SystemdInhibitWakeLock: WakeLock, @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    public init() {}
    public var isHeld: Bool { lock.withLock { process?.isRunning == true } }

    public func acquire() {
        lock.withLock {
            guard process?.isRunning != true else { return }
            guard let executable = ExecutableLocator.find("systemd-inhibit") else {
                Log.warn("[ui] wakelock: systemd-inhibit not available: executable file not found in $PATH")
                return
            }
            let inhibit = Process()
            inhibit.executableURL = URL(fileURLWithPath: executable)
            inhibit.arguments = ["--what=sleep:idle", "--who=tsq", "--why=TaskSquad agent pulling tasks", "--mode=block", "sleep", "infinity"]
            do { try inhibit.run(); process = inhibit }
            catch { Log.warn("[ui] wakelock: systemd-inhibit not available: \(error.localizedDescription)") }
        }
    }

    public func release() {
        lock.withLock {
            if process?.isRunning == true { kill(process!.processIdentifier, SIGKILL) } // Go: Process.Kill
            process = nil
        }
    }
    deinit { release() }
}

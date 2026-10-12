import Foundation

/// Go's logger package: "<RFC3339> [LEVEL] msg" lines to stdout and
/// ~/.tasksquad/logs/daemon-<day>.log, reopened when the day changes. Both daemons
/// append to the same file. Until `configure` runs (tests, previews) lines go to stderr.
public enum Log {
    private static let sink = Sink()

    public static func configure(logs: URL, stdout: @escaping @Sendable (String) -> Void) { sink.configure(logs: logs, stdout: stdout) }
    public static func info(_ message: String) { sink.write("INFO", message) }
    public static func debug(_ message: String) { sink.write("DEBUG", message) }
    public static func warn(_ message: String) { sink.write("WARN", message) }
    public static func error(_ message: String) { sink.write("ERROR", message) }
    /// Go's logger.Lifecycle: task lifecycle events.
    public static func event(_ message: String) { sink.write("EVENT", message) }

    /// Go's %q (strconv.Quote) for the strings it quotes in log lines.
    public static func quote(_ value: String) -> String {
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\t": out += "\\t"
            case "\r": out += "\\r"
            case _ where scalar.value < 0x20 || scalar.value == 0x7F: out += String(format: "\\x%02x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }

    /// Go main.go's startup banner, shared by the headless `tsq` and the app.
    public static func daemonStarting(_ configuration: DaemonConfiguration, version: String, email: String) {
        info("TaskSquad daemon starting — tsq " + version)
        info("API: \(configuration.server.url)")
        info("Poll interval: \(configuration.server.pollInterval)s")
        info("Hooks port: \(configuration.hooks.port)")
        info("User: \(email)")
        for agent in configuration.agents {
            info("  - \(agent.name)  id=\(agent.id)  command=\(agent.command)  dir=\(agent.workDir)  provider=\(ProviderKind.detect(command: agent.command, override: agent.provider).rawValue)")
        }
    }

    private final class Sink: @unchecked Sendable {
        private let lock = NSLock()
        private var logs: URL?
        private var stdout: @Sendable (String) -> Void = { FileHandle.standardError.write(Data($0.utf8)) }
        private var day = ""
        private var handle: FileHandle?

        func configure(logs: URL, stdout: @escaping @Sendable (String) -> Void) {
            lock.lock(); defer { lock.unlock() }
            try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
            try? handle?.close(); handle = nil
            self.logs = logs; self.stdout = stdout; day = ""
        }

        func write(_ level: String, _ message: String) {
            lock.lock(); defer { lock.unlock() }
            let now = Date()
            if let logs {
                let today = String(GoTime.rfc3339(now).prefix(10))
                if today != day {
                    try? handle?.close()
                    let url = logs.appendingPathComponent("daemon-\(today).log")
                    if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
                    handle = try? FileHandle(forWritingTo: url); _ = try? handle?.seekToEnd()
                    day = today
                }
            }
            let padded = level.padding(toLength: max(5, level.count), withPad: " ", startingAt: 0)
            let line = "\(GoTime.rfc3339(now)) [\(padded)] \(message)\n"
            stdout(line)
            try? handle?.write(contentsOf: Data(line.utf8))
        }
    }
}

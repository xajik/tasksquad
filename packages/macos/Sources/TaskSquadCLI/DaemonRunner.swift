import Darwin
import Foundation
import TaskSquadCore

/// `tsq` with no subcommand: the headless daemon (Go: main.go runDaemon with the
/// non-tray ui stub). Logs to stdout and ~/.tasksquad/logs/daemon-<date>.log like
/// Go's logger, holds a wake lock, and stops cleanly on SIGINT/SIGTERM.
public enum DaemonRunner {
    /// Go's logger: "<RFC3339> [LEVEL] msg" to stdout and the day's daemon log, rotating daily.
    final class DaemonLog: @unchecked Sendable {
        private let lock = NSLock()
        private let logs: URL
        private let stdout: @Sendable (String) -> Void
        private var day = ""
        private var handle: FileHandle?
        init(paths: TaskSquadPaths, stdout: @escaping @Sendable (String) -> Void) {
            logs = paths.logs; self.stdout = stdout
            try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        }
        func write(_ level: String, _ message: String) {
            lock.lock(); defer { lock.unlock() }
            let now = Date()
            let today = now.formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day().dateSeparator(.dash))
            if today != day {
                try? handle?.close()
                let url = logs.appendingPathComponent("daemon-\(today).log")
                if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
                handle = try? FileHandle(forWritingTo: url); _ = try? handle?.seekToEnd()
                day = today
            }
            let padded = level.padding(toLength: max(5, level.count), withPad: " ", startingAt: 0)
            let line = "\(GoTime.rfc3339(now)) [\(padded)] \(message)\n"
            stdout(line)
            try? handle?.write(contentsOf: Data(line.utf8))
        }
    }

    public static func run(_ arguments: [String], context c: CLIContext = CLIContext()) async -> Int32 {
        let flags = GoFlagSet(c.programName, output: c.stderr)
        flags.string("config", c.paths.config.path, "path to config.toml")
        flags.string("api-url", "", "override API URL from config")
        flags.bool("version", false, "print version and exit")
        do { try flags.parse(arguments) } catch GoFlagSet.ParseError.help { return 0 } catch { return 2 }
        if flags[bool: "version"] { c.print("tsq " + c.version); return 0 }

        var configuration: DaemonConfiguration
        do {
            let path = URL(fileURLWithPath: flags[string: "config"])
            guard FileManager.default.fileExists(atPath: path.path) else { throw ConfigurationError("config file not found at \(path.path)\nRun: tsq init") }
            configuration = try DaemonConfiguration.load(from: path, paths: c.paths)
        } catch { c.printError("error loading config: \(error.localizedDescription)"); return 1 }
        if !flags[string: "api-url"].isEmpty { configuration.server.url = flags[string: "api-url"] }

        if !(await c.isLoggedIn(c.environment)) {
            c.print("Not logged in — starting login flow...")
            do {
                let email = try await c.login(c, c.dashboardURL(configuration.server.url), configuration.server.url, configuration.firebase.apiKey)
                c.print("Logged in as \(email)\n")
            } catch { c.printError("login failed: \(error.localizedDescription)"); return 1 }
        }

        let log = DaemonLog(paths: c.paths, stdout: c.stdout)
        log.write("INFO", "TaskSquad daemon starting — tsq " + c.version)
        log.write("INFO", "API: \(configuration.server.url)")
        log.write("INFO", "Poll interval: \(configuration.server.pollInterval)s")
        log.write("INFO", "Hooks port: \(configuration.hooks.port)")
        for agent in configuration.agents {
            log.write("INFO", "  - \(agent.name)  id=\(agent.id)  command=\(agent.command)  dir=\(agent.workDir)  provider=\(ProviderKind.detect(command: agent.command, override: agent.provider).rawValue)")
        }
        let engine = DaemonEngine(configuration: configuration, paths: c.paths, tokens: c.tokenProvider(configuration), environment: c.environment,
                                  appVersion: c.version) { message in log.write("ERROR", message) }
        do { try await engine.start() } catch { c.printError(error.localizedDescription); return 1 }
        log.write("INFO", "Running — waiting for tasks...")
        let executable = URL(fileURLWithPath: CommandLine.arguments.first ?? "tsq").resolvingSymlinksInPath().path
        do {
            if try LaunchAgent(home: c.home).enableOnFirstRun(executable: executable, paths: c.paths) {
                log.write("INFO", "[autostart] Enabled run-on-boot (first run)")
            }
        } catch { log.write("WARN", "[autostart] first-run enable failed: \(error.localizedDescription)") }
        let wakeLock = WakeLock()
        wakeLock.acquire()
        await waitForTermination()
        log.write("INFO", "Shutting down — draining sessions...")
        await engine.stop()
        wakeLock.release()
        return 0
    }

    /// Suspends until SIGINT or SIGTERM.
    static func waitForTermination() async {
        signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let queue = DispatchQueue(label: "tsq.signals")
            let resumed = SignalOnce(continuation)
            for number in [SIGINT, SIGTERM] {
                let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
                source.setEventHandler { resumed.fire() }
                source.resume()
                resumed.keep(source)
            }
        }
    }

    private final class SignalOnce: @unchecked Sendable {
        private var continuation: CheckedContinuation<Void, Never>?
        private var sources: [DispatchSourceSignal] = []
        init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }
        func keep(_ source: DispatchSourceSignal) { sources.append(source) }
        func fire() { continuation?.resume(); continuation = nil }
    }
}

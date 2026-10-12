import Darwin
import Foundation
import TaskSquadCore

/// `tsq` with no subcommand: the headless daemon (Go: main.go runDaemon with the
/// non-tray ui stub). Logs to stdout and ~/.tasksquad/logs/daemon-<date>.log like
/// Go's logger, holds a wake lock, and stops cleanly on SIGINT/SIGTERM.
public enum DaemonRunner {
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

        Log.configure(logs: c.paths.logs, stdout: c.stdout)
        Log.daemonStarting(configuration, version: c.version, email: c.storedEmail())
        // The engine logs its own errors; the app additionally shows them through this callback.
        let engine = DaemonEngine(configuration: configuration, paths: c.paths, tokens: c.tokenProvider(configuration), environment: c.environment,
                                  appVersion: c.version)
        do { try await engine.start() } catch { c.printError(error.localizedDescription); return 1 }
        Log.info("Running — waiting for tasks...")
        let executable = URL(fileURLWithPath: CommandLine.arguments.first ?? "tsq").resolvingSymlinksInPath().path
        do {
            if try LaunchAgent(home: c.home).enableOnFirstRun(executable: executable, paths: c.paths) {
                Log.info("[autostart] Enabled run-on-boot (first run)")
            }
        } catch { Log.warn("[autostart] first-run enable failed: \(error.localizedDescription)") }
        let wakeLock = WakeLock()
        wakeLock.acquire()
        await waitForTermination()
        Log.info("Shutting down — draining sessions...")
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

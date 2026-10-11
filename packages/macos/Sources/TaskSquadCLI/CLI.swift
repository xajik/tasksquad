import Foundation
import TaskSquadCore

/// Where a command reads and writes; tests substitute buffers and an isolated HOME / tmux.
public struct CLIContext: Sendable {
    public var environment: [String: String]
    public var stdout: @Sendable (String) -> Void
    public var stderr: @Sendable (String) -> Void
    public var stdin: @Sendable () -> Data
    public var now: @Sendable () -> Date
    /// Runs a child with this process's terminal (tmux attach); returns its exit status.
    public var interactive: @Sendable (_ executable: String, _ arguments: [String], _ environment: [String: String]) -> Int32

    public init(environment: [String: String] = ProcessInfo.processInfo.environment,
                stdout: @escaping @Sendable (String) -> Void = { FileHandle.standardOutput.write(Data($0.utf8)) },
                stderr: @escaping @Sendable (String) -> Void = { FileHandle.standardError.write(Data($0.utf8)) },
                stdin: @escaping @Sendable () -> Data = { FileHandle.standardInput.readDataToEndOfFile() },
                now: @escaping @Sendable () -> Date = { Date() },
                interactive: @escaping @Sendable (String, [String], [String: String]) -> Int32 = CLIContext.runInheritingTerminal) {
        self.environment = environment; self.stdout = stdout; self.stderr = stderr; self.stdin = stdin; self.now = now; self.interactive = interactive
    }

    public var home: URL { URL(fileURLWithPath: environment["HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path) }
    public var paths: TaskSquadPaths { TaskSquadPaths(home: home) }
    /// Go formats local times with $TZ from its environment.
    public var timeZone: TimeZone { environment["TZ"].flatMap { TimeZone(identifier: $0) } ?? .current }
    /// Go execs the bare `tmux` on PATH against the default server.
    public var tmux: TmuxConnection {
        TmuxConnection(executable: ExecutableLocator.find("tmux", environment: environment) ?? "tmux", environment: environment)
    }
    func print(_ line: String = "") { stdout(line + "\n") }
    func printError(_ line: String) { stderr(line + "\n") }

    public static func runInheritingTerminal(_ executable: String, _ arguments: [String], _ environment: [String: String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        process.standardInput = FileHandle.standardInput
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError
        do { try process.run() } catch { return 127 }
        process.waitUntilExit()
        return process.terminationStatus
    }
}

/// The `tsq` command line: the same binary as the app, dispatched before any UI starts.
/// Ports packages/daemon/main.go's subcommands and their output byte for byte.
public enum TSQCommandLine {
    /// Subcommands the Go `tsq` handles (everything else starts the daemon/app).
    public static let commands: Set<String> = [
        "projects", "agents", "tasks", "portals", "resources", "doctor", "init", "login", "logout", "sessions", "attach",
        "logs", "pane", "screenshot", "send", "report", "send-image", "skill", "memory", "kb", "tags",
    ]
    /// Implemented so far; the rest are still handled by the app's legacy paths.
    static let implemented: Set<String> = ["sessions", "attach", "logs", "pane", "screenshot", "send", "report", "send-image", "skill"]

    public static func handles(_ arguments: [String]) -> Bool {
        guard let first = arguments.first else { return false }
        return implemented.contains(first)
    }

    /// `arguments` excludes the program name. Returns the process exit status.
    public static func run(_ arguments: [String], context: CLIContext = CLIContext()) async -> Int32 {
        guard let command = arguments.first else { return 2 }
        let rest = Array(arguments.dropFirst())
        switch command {
        case "sessions": return await LocalCommands.sessions(context)
        case "attach": return await LocalCommands.attach(rest, context)
        case "logs": return LocalCommands.logs(rest, context)
        case "pane": return await LocalCommands.pane(rest, context)
        case "send": return await LocalCommands.send(rest, context)
        case "screenshot": return await LocalCommands.screenshot(rest, context)
        case "report": return await HookCommands.report(rest, context)
        case "send-image": return await HookCommands.sendImage(rest, context)
        case "skill": return await HookCommands.skill(rest, context)
        default:
            context.printError("tsq: \(command) is not implemented in this build")
            return 2
        }
    }
}

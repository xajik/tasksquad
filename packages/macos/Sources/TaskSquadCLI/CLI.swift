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
    /// Go's os.Getwd(): commands resolve the current agent from it.
    public var workingDirectory: String
    /// nil signs in like the daemon (shared Keychain credentials); tests inject one.
    public var tokens: (any TokenProvider)?
    public var transport: any HTTPTransport
    /// Browser sign-in; returns the email (Go: auth.Login). Tests substitute it.
    public var login: @Sendable (_ context: CLIContext, _ dashboardURL: String, _ apiURL: String, _ firebaseAPIKey: String) async throws -> String
    /// Deletes stored credentials (Go: auth.Logout). Tests substitute it.
    public var logout: @Sendable () async throws -> Void
    /// Go's auth.IsLoggedIn: an ID token is stored.
    public var isLoggedIn: @Sendable (_ environment: [String: String]) async -> Bool
    /// Go's auth.GetEmail, for the daemon's "User:" line.
    public var storedEmail: @Sendable () -> String = { (try? KeychainCredentialStore().read(.email)) ?? "" }
    /// Cloud orchestration never follows redirects (Go: CustomerClient).
    public var customerTransport: any HTTPTransport
    public var version: String
    /// Go's os.Args[0], shown in the daemon's "Usage of …" header.
    public var programName = CommandLine.arguments.first ?? "tsq"

    public init(environment: [String: String] = ProcessInfo.processInfo.environment,
                stdout: @escaping @Sendable (String) -> Void = { FileHandle.standardOutput.write(Data($0.utf8)) },
                stderr: @escaping @Sendable (String) -> Void = { FileHandle.standardError.write(Data($0.utf8)) },
                stdin: @escaping @Sendable () -> Data = { FileHandle.standardInput.readDataToEndOfFile() },
                now: @escaping @Sendable () -> Date = { Date() },
                interactive: @escaping @Sendable (String, [String], [String: String]) -> Int32 = CLIContext.runInheritingTerminal,
                workingDirectory: String = FileManager.default.currentDirectoryPath, tokens: (any TokenProvider)? = nil,
                transport: any HTTPTransport = NativeHTTPTransport(),
                login: @escaping @Sendable (CLIContext, String, String, String) async throws -> String = CLIContext.browserLogin,
                logout: @escaping @Sendable () async throws -> Void = { try await Authentication(apiURL: "", firebaseAPIKey: "").logout() },
                isLoggedIn: @escaping @Sendable ([String: String]) async -> Bool = CLIContext.keychainHasIDToken,
                customerTransport: (any HTTPTransport)? = nil, version: String = "dev") {
        self.environment = environment; self.stdout = stdout; self.stderr = stderr; self.stdin = stdin; self.now = now; self.interactive = interactive
        self.workingDirectory = workingDirectory; self.tokens = tokens; self.transport = transport
        self.login = login; self.logout = logout; self.isLoggedIn = isLoggedIn
        self.customerTransport = customerTransport ?? NoRedirectTransport(); self.version = version
    }

    /// Like go-keyring on macOS: `security find-generic-password` (never blocks on Keychain UI from a tool).
    public static func keychainHasIDToken(environment: [String: String]) async -> Bool {
        let output = KeychainProbe()
        let status = try? await NativeProcess.run(.init(executable: "/usr/bin/security",
            arguments: ["find-generic-password", "-s", "tasksquad-daemon", "-wa", CredentialKey.idToken.rawValue], environment: environment)) { channel, data in
            if channel == .stdout { await output.append(data) }
        }
        let text = await output.text
        return status?.code == 0 && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public static func browserLogin(_ c: CLIContext, dashboardURL: String, apiURL: String, firebaseAPIKey: String) async throws -> String {
        let flow = try await LoginFlow.begin(dashboardURL: dashboardURL)
        c.print("Opening browser for login...")
        c.print("If the browser doesn't open, visit:\n  \(flow.browserURL.absoluteString)\n")
        _ = c.interactive("/usr/bin/open", [flow.browserURL.absoluteString], c.environment)
        let callback = try await flow.result()
        try await Authentication(transport: c.transport, apiURL: apiURL, firebaseAPIKey: firebaseAPIKey)
            .acceptLogin(idToken: callback.idToken, refreshToken: callback.refreshToken, email: callback.email)
        return callback.email
    }

    /// Go's dashboardURL: TSQ_DASHBOARD_URL, else the API host mapped to the portal.
    func dashboardURL(_ serverURL: String) -> String {
        if let override = environment["TSQ_DASHBOARD_URL"], !override.isEmpty { return override }
        if serverURL.hasSuffix(".api.tasksquad.ai") || serverURL == "https://api.tasksquad.ai" { return "https://tasksquad.ai" }
        return serverURL.hasSuffix("/api") ? String(serverURL.dropLast(4)) : serverURL
    }

    /// Go's config.Load: a missing file or no agents is an error for daemon-side commands.
    func loadConfiguration() throws -> DaemonConfiguration {
        let path = paths.config
        guard FileManager.default.fileExists(atPath: path.path) else { throw ConfigurationError("config file not found at \(path.path)\nRun: tsq init") }
        let configuration = try DaemonConfiguration.load(from: path)
        guard !configuration.agents.isEmpty else { throw ConfigurationError("at least one [[agents]] entry is required") }
        if let index = configuration.agents.firstIndex(where: { $0.id.isEmpty }) { throw ConfigurationError("agents[\(index)].id is required") }
        return configuration
    }

    func tokenProvider(_ configuration: DaemonConfiguration) -> any TokenProvider {
        tokens ?? Authentication(transport: transport, apiURL: configuration.server.url, firebaseAPIKey: configuration.firebase.apiKey)
    }

    /// Go's agentctx.CurrentAgentID: the agent whose cleaned work_dir equals the cwd.
    func currentAgentID(_ configuration: DaemonConfiguration) -> String {
        let cwd = (workingDirectory as NSString).standardizingPath
        return configuration.agents.first { !$0.workDir.isEmpty && ($0.workDir as NSString).standardizingPath == cwd }?.id ?? ""
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
    static let implemented: Set<String> = ["sessions", "attach", "logs", "pane", "screenshot", "send", "report", "send-image", "skill",
                                           "memory", "kb", "tags", "login", "logout", "init",
                                           "projects", "agents", "tasks", "portals", "resources", "doctor"]

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
        case "projects", "agents", "tasks", "portals", "resources", "doctor":
            return await CustomerCommands.run(arguments, version: context.version, context)
        case "login": return await AuthCommands.login(context)
        case "logout": return await AuthCommands.logout(context)
        case "init": return await AuthCommands.initialize(context)
        case "memory": return await KnowledgeCommands.memory(rest, context)
        case "kb": return await KnowledgeCommands.kb(rest, context)
        case "tags": return await KnowledgeCommands.tags(rest, context)
        default:
            context.printError("tsq: \(command) is not implemented in this build")
            return 2
        }
    }
}

private actor KeychainProbe {
    var data = Data()
    func append(_ chunk: Data) { data.append(chunk) }
    var text: String { String(decoding: data, as: UTF8.self) }
}

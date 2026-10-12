import Foundation
import TaskSquadCore

/// `tsq login`, `tsq logout`, `tsq init` (Go: cmd/auth).
enum AuthCommands {
    static func login(_ c: CLIContext) async -> Int32 {
        // Go falls back to the public API when config.Load fails (missing file, no agents).
        let configuration = (try? c.loadConfiguration()) ?? {
            var fallback = DaemonConfiguration.defaults; fallback.server.url = "https://tasksquad.ai"; return fallback
        }()
        do {
            let email = try await c.login(c, c.dashboardURL(configuration.server.url), configuration.server.url, configuration.firebase.apiKey)
            c.print("Logged in as \(email)")
            return 0
        } catch { c.printError("login failed: \(error.localizedDescription)"); return 1 }
    }

    static func logout(_ c: CLIContext) async -> Int32 {
        do { try await c.logout() } catch { c.printError("logout error: \(error.localizedDescription)"); return 1 }
        c.print("Logged out.")
        return 0
    }

    /// Interactive setup: log in, list the user's agents, ask each one's command and
    /// work directory, write ~/.tasksquad/config.toml (0600) exactly as Go does.
    static func initialize(_ c: CLIContext) async -> Int32 {
        c.print("TaskSquad daemon setup")
        c.print("----------------------")
        c.print()
        c.print("Step 1: Log in to TaskSquad")
        var configuration = DaemonConfiguration.defaults
        configuration.server.url = "https://api.tasksquad.ai"
        configuration.firebase.apiKey = ""
        let dashboard = c.dashboardURL(configuration.server.url)
        do {
            let email = try await c.login(c, dashboard, configuration.server.url, configuration.firebase.apiKey)
            c.print("Logged in as \(email)\n")
        } catch { c.printError("login failed: \(error.localizedDescription)"); return 1 }

        c.print("Step 2: Fetching your agents from the server...")
        let agents: [JSONValue]
        do {
            let token = try await c.tokenProvider(configuration).token(forceRotation: false)
            let request = try WorkerAPI(baseURL: configuration.server.url, transport: c.transport).request(method: "GET", path: "/daemon/user/agents", token: token)
            let result = try await c.transport.send(request)
            guard (200..<300).contains(result.status) else {
                c.printError("failed to fetch agents: HTTP \(result.status): \(String(decoding: result.data, as: UTF8.self))"); return 1
            }
            guard let decoded = try? JSONDecoder().decode(JSONValue.self, from: result.data) else { c.printError("failed to fetch agents: parse response"); return 1 }
            agents = decoded["agents"]?.array ?? []
        } catch { c.printError("auth error: \(error.localizedDescription)"); return 1 }
        guard !agents.isEmpty else {
            c.print("No agents found. Create agents in the TaskSquad portal first.")
            c.print("  \(dashboard)/dashboard")
            return 1
        }
        c.print("Found \(agents.count) agent(s):")
        for agent in agents { c.print("  - \(agent["name"]?.string ?? "") (id: \(agent["id"]?.string ?? ""))") }
        c.print()

        // fmt.Scanln(&v): one whitespace-separated token per line; extra words are dropped.
        var input = String(decoding: c.stdin(), as: UTF8.self).components(separatedBy: "\n")[...]
        func readLine(_ prompt: String, _ fallback: String) -> String {
            c.stdout(fallback.isEmpty ? "\(prompt): " : "\(prompt) [\(fallback)]: ")
            let line = input.popFirst() ?? ""
            let token = line.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\r" }).first.map(String.init) ?? ""
            return token.isEmpty ? fallback : token
        }
        var blocks: [String] = []
        for agent in agents {
            let id = agent["id"]?.string ?? "", name = agent["name"]?.string ?? ""
            c.print("Configure agent: \(name)")
            let command = readLine("  CLI command", "claude")
            let workDir = readLine("  Work directory", "~/Projects")
            let provider = ProviderKind.detect(command: command, override: "")
            func q(_ s: String) -> String { GoFlagSet.goQuote(s) }
            blocks.append("[[agents]]\nid       = \(q(id))\nname     = \(q(name))\ncommand  = \(q(command))\n# provider = \(q(provider.rawValue))\nwork_dir = \(q(workDir))\n")
            c.print()
        }
        let path = c.paths.config
        do {
            try FileManager.default.createDirectory(at: c.paths.root, withIntermediateDirectories: true)
            try Data(blocks.joined(separator: "\n").utf8).write(to: path)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
        } catch { c.printError("error writing config: \(error.localizedDescription)"); return 1 }
        c.print("Config written to \(path.path)")
        c.print("Run: tsq")
        return 0
    }
}

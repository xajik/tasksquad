import Foundation
import CryptoKit

/// Server-managed resources installed into every agent work directory.
/// Port of packages/daemon/{skills,agents,commands} and harness/{harness,codex}.go.
/// Lock files keep Go's names and JSON shape, so either daemon can take over.
public enum ManagedResource: String, CaseIterable, Sendable {
    case skills, subAgents = "agents", commands

    var listPath: String {
        switch self { case .skills: "/daemon/user/skills"; case .subAgents: "/daemon/user/sub-agents"; case .commands: "/daemon/user/commands" }
    }
    var envelope: String {
        switch self { case .skills: "skills"; case .subAgents: "sub_agents"; case .commands: "commands" }
    }
    /// The singular noun in Go's sync log lines.
    var logNoun: String {
        switch self { case .skills: "skill"; case .subAgents: "sub-agent"; case .commands: "command" }
    }
    func detailPath(id: String, teamID: String) -> String {
        let segment = self == .subAgents ? "sub-agents" : rawValue
        return teamID.isEmpty ? "/daemon/\(segment)/\(id)" : "/teams/\(teamID)/\(segment)/\(id)"
    }
}

/// On-disk layout shared by the AI CLI harnesses (harness/harness.go).
enum HarnessLayout {
    /// .claude (Claude Code), .agents (Gemini, Codex), .agent (Claw), .gemini, .pi, .forge.
    static let bases = [".claude", ".agents", ".agent", ".gemini", ".pi", ".forge"]
    /// Slash commands also go to OpenCode.
    static let commandBases = [".claude", ".agents", ".agent", ".gemini", ".opencode", ".pi", ".forge"]
    static let codexManaged = "# Managed by TaskSquad; edits are replaced on sync.\n"
    static let commandManaged = "<!-- Managed by TaskSquad command sync. -->"
    static let skillManaged = "<!-- Managed by TaskSquad skill sync. -->"

    /// Server names become path components and TOML keys; reject anything else.
    static func isSafe(_ name: String) -> Bool {
        name.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]*$", options: .regularExpression) != nil
    }

    static func stripFrontmatter(_ content: String) -> String {
        let normalized = content.replacingOccurrences(of: "\r\n", with: "\n")
        guard normalized.hasPrefix("---\n"), let end = normalized.dropFirst(4).range(of: "\n---\n") else { return content }
        return normalized[end.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Writes atomically, but never replaces a file someone authored without our marker.
    static func writeManaged(_ url: URL, _ text: String, marker: String) throws {
        if let old = try? String(contentsOf: url, encoding: .utf8), !old.contains(marker) { return }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url, options: .atomic)
    }

    static func removeManaged(_ url: URL, marker: String) {
        if let old = try? String(contentsOf: url, encoding: .utf8), old.contains(marker) { try? FileManager.default.removeItem(at: url) }
    }

    /// Codex discovers skills in .agents/skills. The marker goes after YAML
    /// frontmatter so Codex's discovery metadata stays intact.
    static func codexSkill(_ content: String) throws -> String {
        guard content.hasPrefix("---\n") else { return skillManaged + "\n" + content }
        guard let end = content.dropFirst(4).range(of: "\n---\n") else { throw ConfigurationError("Invalid skill frontmatter") }
        return String(content[..<end.upperBound]) + skillManaged + "\n" + String(content[end.upperBound...])
    }

    static func codexCommand(name: String, content: String) -> String {
        "---\nname: source-command-\(name)\ndescription: Run the TaskSquad \(name) command.\n---\n\(commandManaged)\n\n\(stripFrontmatter(content))\n"
    }

    static func codexAgent(name: String, description: String, content: String) -> String {
        func quoted(_ value: String) -> String {
            var out = "\""
            for scalar in value.unicodeScalars {
                switch scalar {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case "\n": out += "\\n"
                case "\t": out += "\\t"
                case "\r": out += "\\r"
                default:
                    if scalar.value < 0x20 || scalar.value == 0x7F { out += String(format: "\\u%04X", scalar.value) }
                    else { out.unicodeScalars.append(scalar) }
                }
            }
            return out + "\""
        }
        return codexManaged + "name = \(quoted(name))\ndescription = \(quoted(description.isEmpty ? name : description))\n"
            + "developer_instructions = \(quoted(stripFrontmatter(content)))\n"
    }
}

/// Polls hourly (and on demand) and installs the user's auto-install and server
/// default resources, removing ones deleted on the server. Only lock-tracked
/// entries are ever removed, so user-authored files are never touched.
/// One immediate skills/sub-agents/commands sync for the given agents (Go: skills/agents/commands SyncNow).
public enum ResourceSyncNow {
    public static func run(configuration: DaemonConfiguration, agents: [DaemonConfiguration.Agent], tokens: any TokenProvider,
                           transport: any HTTPTransport, paths: TaskSquadPaths) async {
        let sync = ResourceSync(api: WorkerAPI(baseURL: configuration.server.url, transport: transport), tokens: tokens, paths: paths,
                                agents: agents) { Log.warn($0) }
        await sync.syncAll()
    }
}

actor ResourceSync {
    struct Target: Sendable { let agentID: String; let workDir: String }
    private let api: WorkerAPI
    private let tokens: any TokenProvider
    private let paths: TaskSquadPaths
    private let targets: [Target]
    private let interval: Duration
    private let report: @Sendable (String) -> Void
    private var loop: Task<Void, Never>?
    private var trigger: AsyncStream<Void>.Continuation?

    init(api: WorkerAPI, tokens: any TokenProvider, paths: TaskSquadPaths, agents: [DaemonConfiguration.Agent],
         interval: Duration = .seconds(3600), report: @escaping @Sendable (String) -> Void) {
        self.api = api; self.tokens = tokens; self.paths = paths; self.interval = interval; self.report = report
        // One sync per work directory, attributed to the first agent using it (as in Go).
        var seen = Set<String>()
        targets = agents.compactMap { agent in
            guard !agent.workDir.isEmpty, seen.insert(agent.workDir).inserted else { return nil }
            return Target(agentID: agent.id, workDir: agent.workDir)
        }
    }

    func start() {
        guard loop == nil, !targets.isEmpty else { return }
        let (stream, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        trigger = continuation
        let interval = interval
        Log.info("[agents] Sub-agent sync started (interval=1h)")
        Log.info("[commands] Auto-install sync started (interval=1h)")
        Log.info("[skills] Auto-install sync started (interval=1h)")
        loop = Task { [weak self] in
            await self?.syncAll()
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: interval) } catch { return }
                        continuation.yield()
                    }
                }
                group.addTask { [weak self] in
                    for await _ in stream { await self?.syncAll() }
                }
                await group.next(); group.cancelAll()
            }
        }
    }

    /// Non-blocking; coalesces with a pending request (Go: Syncer.ForceSync).
    func forceSync() {
        for kind in ManagedResource.allCases { Log.info("[\(kind.rawValue)] force-sync triggered") }
        trigger?.yield()
    }

    func stop() async {
        trigger?.finish(); trigger = nil
        loop?.cancel(); await loop?.value; loop = nil
    }

    func syncAll() async {
        let token: String
        do { token = try await tokens.token(forceRotation: false) } catch {
            for kind in ManagedResource.allCases { Log.error("[\(kind.rawValue)] Sync auth failed: \(error.localizedDescription)") }
            return
        }
        for target in targets {
            for kind in ManagedResource.allCases {
                guard !Task.isCancelled else { return }
                await sync(kind, target: target, token: token)
            }
        }
    }

    private func sync(_ kind: ManagedResource, target: Target, token: String) async {
        let list: JSONValue
        do {
            let result = try await api.send(method: "GET", path: kind.listPath + "?agent_id=" + target.agentID, token: token)
            list = try JSONDecoder().decode(JSONValue.self, from: result.data)
        } catch { Log.error("[\(kind.rawValue)] Sync fetch failed for agent \(target.agentID): \(error.localizedDescription)"); return }
        let items = list[kind.envelope]?.array ?? []
        Log.debug("[\(kind.rawValue)] Sync found \(items.count) potential \(kind.logNoun)s for agent \(target.agentID)")

        let workDir = URL(fileURLWithPath: target.workDir, isDirectory: true)
        var lock = loadLock(kind, workDir: target.workDir)
        var serverNames = Set<String>()
        var installed = 0, removed = 0
        for item in items {
            guard item["auto_install"]?.number ?? 0 != 0 || item["is_default"]?.number ?? 0 != 0,
                  let name = item["name"]?.string, HarnessLayout.isSafe(name) else { continue }
            serverNames.insert(name)
            var etag = item["etag"]?.string ?? ""
            if !etag.isEmpty, lock[name] == etag, upToDate(kind, name: name, workDir: workDir, description: item["description"]?.string ?? "") { continue }
            var content = item["content"]?.string ?? ""
            if content.isEmpty, let id = item["id"]?.string, !id.isEmpty {
                do {
                    let result = try await api.send(method: "GET", path: kind.detailPath(id: id, teamID: item["team_id"]?.string ?? ""),
                                                    token: token)
                    let full = try JSONDecoder().decode(JSONValue.self, from: result.data)
                    content = full["content"]?.string ?? ""
                    if let fresh = full["etag"]?.string, !fresh.isEmpty { etag = fresh }
                } catch { Log.error("[\(kind.rawValue)] Failed to fetch \(kind.logNoun) \(Log.quote(name)) content: \(error.localizedDescription)"); continue }
            }
            guard !content.isEmpty else { Log.warn("[\(kind.rawValue)] Skipping \(Log.quote(name)) — no content received"); continue }
            do {
                try install(kind, name: name, description: item["description"]?.string ?? "", content: content, workDir: workDir, tracked: lock[name] != nil)
                lock[name] = etag; installed += 1
                let version = Int(item["version"]?.number ?? 0)
                Log.info("[\(kind.rawValue)] Installed \(kind == .subAgents ? "sub-agent " : "")\(Log.quote(name)) v\(version) → \(target.workDir)")
            } catch { report("[\(kind.rawValue)] Failed to install \(Log.quote(name)): \(error.localizedDescription)") }
        }
        for name in lock.keys where !serverNames.contains(name) {
            remove(kind, name: name, workDir: workDir); lock[name] = nil; removed += 1
            Log.info("[\(kind.rawValue)] Removed \(kind == .subAgents ? "sub-agent " : "")\(Log.quote(name)) from \(target.workDir) (deleted on server)")
        }
        saveLock(kind, workDir: target.workDir, lock)
        if installed + removed > 0 { Log.info("[\(kind.rawValue)] Sync complete for agent \(target.agentID): \(installed) installed, \(removed) removed") }
        else { Log.debug("[\(kind.rawValue)] Sync complete for agent \(target.agentID): all up to date") }
    }

    private func canonical(_ kind: ManagedResource, name: String, workDir: URL) -> URL {
        workDir.appendingPathComponent(kind == .skills ? ".tsq/skills/\(name)/SKILL.md" : ".tsq/\(kind.rawValue)/\(name).md")
    }

    private func upToDate(_ kind: ManagedResource, name: String, workDir: URL, description: String) -> Bool {
        guard let body = try? String(contentsOf: canonical(kind, name: name, workDir: workDir), encoding: .utf8) else { return false }
        do {
            // Equal server content does not imply that every provider copy exists.
            try install(kind, name: name, description: description, content: body, workDir: workDir, tracked: true)
            return true
        } catch { report(error.localizedDescription); return false }
    }

    private func install(_ kind: ManagedResource, name: String, description: String, content: String, workDir: URL, tracked: Bool) throws {
        let source = canonical(kind, name: name, workDir: workDir)
        let previous = try? String(contentsOf: source, encoding: .utf8)
        guard tracked || previous == nil || previous == content else {
            throw ConfigurationError("Resource conflict: \(source.path); preserving local content")
        }
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Keep the previous canonical bytes until all provider copies are reconciled.
        let bases = kind == .commands ? HarnessLayout.commandBases : HarnessLayout.bases
        for base in bases {
            if kind == .skills && base == ".agents" { continue }
            let relative = kind == .skills ? "skills/\(name)/SKILL.md" : "\(kind.rawValue)/\(name).md"
            let destination = workDir.appendingPathComponent("\(base)/\(relative)")
            if let old = try? String(contentsOf: destination, encoding: .utf8), old != content,
               !(tracked && previous != nil && old == previous) {
                report("Resource conflict: \(destination.path); preserving local content")
                continue
            }
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(content.utf8).write(to: destination, options: .atomic)
        }
        switch kind {
        case .skills:
            try HarnessLayout.writeManaged(workDir.appendingPathComponent(".agents/skills/\(name)/SKILL.md"),
                                           try HarnessLayout.codexSkill(content), marker: HarnessLayout.skillManaged)
        case .subAgents:
            try HarnessLayout.writeManaged(workDir.appendingPathComponent(".codex/agents/\(name).toml"),
                                           HarnessLayout.codexAgent(name: name, description: description, content: content), marker: HarnessLayout.codexManaged)
        case .commands:
            try HarnessLayout.writeManaged(workDir.appendingPathComponent(".agents/skills/source-command-\(name)/SKILL.md"),
                                           HarnessLayout.codexCommand(name: name, content: content), marker: HarnessLayout.commandManaged)
        }
        try Data(content.utf8).write(to: source, options: .atomic)
    }

    private func remove(_ kind: ManagedResource, name: String, workDir: URL) {
        guard HarnessLayout.isSafe(name) else { return }
        let source = canonical(kind, name: name, workDir: workDir)
        let previous = try? Data(contentsOf: source)
        let bases = kind == .commands ? HarnessLayout.commandBases : HarnessLayout.bases
        for base in bases {
            if kind == .skills && base == ".agents" { continue }
            let relative = kind == .skills ? "skills/\(name)/SKILL.md" : "\(kind.rawValue)/\(name).md"
            let destination = workDir.appendingPathComponent("\(base)/\(relative)")
            if let previous, (try? Data(contentsOf: destination)) == previous { try? FileManager.default.removeItem(at: destination) }
        }
        switch kind {
        case .skills:
            HarnessLayout.removeManaged(workDir.appendingPathComponent(".agents/skills/\(name)/SKILL.md"), marker: HarnessLayout.skillManaged)
        case .subAgents:
            HarnessLayout.removeManaged(workDir.appendingPathComponent(".codex/agents/\(name).toml"), marker: HarnessLayout.codexManaged)
        case .commands:
            HarnessLayout.removeManaged(workDir.appendingPathComponent(".agents/skills/source-command-\(name)/SKILL.md"), marker: HarnessLayout.commandManaged)
        }
        try? FileManager.default.removeItem(at: source)
        // Empty skill directories may be removed, but never their other user files.
        if kind == .skills {
            for base in [".tsq"] + HarnessLayout.bases {
                let directory = workDir.appendingPathComponent("\(base)/skills/\(name)")
                if (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) == [] {
                    try? FileManager.default.removeItem(at: directory)
                }
            }
        }
    }

    // MARK: Lock files — ~/.tasksquad/<kind>-<sha256(workDir)[:8] hex>.lock, {name: etag}

    func lockURL(_ kind: ManagedResource, workDir: String) -> URL {
        let digest = SHA256.hash(data: Data(workDir.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        return paths.root.appendingPathComponent("\(kind.rawValue)-\(digest).lock")
    }
    private func loadLock(_ kind: ManagedResource, workDir: String) -> [String: String] {
        guard let data = try? Data(contentsOf: lockURL(kind, workDir: workDir)),
              let lock = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return lock
    }
    private func saveLock(_ kind: ManagedResource, workDir: String, _ lock: [String: String]) {
        let url = lockURL(kind, workDir: workDir)
        try? paths.createRoot()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(lock) else { return }
        try? data.write(to: url, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

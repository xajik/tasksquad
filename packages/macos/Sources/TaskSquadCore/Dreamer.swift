import Foundation

/// Go's math/rand Go-1 source (rngSource) and Rand.Intn, so a seeded sequence
/// matches the Go daemon exactly. The seed table is generated: GoRand.swift.
struct GoRand {
    private static let length = 607, tap = 273
    private var vec = [Int64](repeating: 0, count: 607)
    private var tapIndex = 0, feed = 0

    init(seed: Int64) {
        func seedrand(_ x: Int32) -> Int32 {
            let a: Int32 = 48271, q: Int32 = 44488, r: Int32 = 3399
            let hi = x / q, lo = x % q
            var value = a &* lo &- r &* hi
            if value < 0 { value &+= Int32.max }
            return value
        }
        tapIndex = 0; feed = Self.length - Self.tap
        var s = seed % Int64(Int32.max)
        if s < 0 { s += Int64(Int32.max) }
        if s == 0 { s = 89_482_311 }
        var x = Int32(s)
        for i in -20..<Self.length {
            x = seedrand(x)
            if i >= 0 {
                var u = Int64(x) << 40
                x = seedrand(x); u ^= Int64(x) << 20
                x = seedrand(x); u ^= Int64(x)
                u ^= Self.cooked[i]
                vec[i] = u
            }
        }
    }

    mutating func uint64() -> UInt64 {
        tapIndex -= 1; if tapIndex < 0 { tapIndex += Self.length }
        feed -= 1; if feed < 0 { feed += Self.length }
        let x = vec[feed] &+ vec[tapIndex]
        vec[feed] = x
        return UInt64(bitPattern: x)
    }
    mutating func int63() -> Int64 { Int64(bitPattern: uint64() & (UInt64(1) << 63 - 1)) }
    mutating func int31() -> Int32 { Int32(truncatingIfNeeded: int63() >> 32) }

    /// Rand.Intn for n ≤ Int32.max (Int31n).
    mutating func intn(_ n: Int) -> Int {
        precondition(n > 0 && n <= Int(Int32.max))
        let n32 = Int32(n)
        if n32 & (n32 - 1) == 0 { return Int(int31() & (n32 - 1)) }
        let limit = Int32(Int64(Int32.max) - Int64((UInt32(1) << 31) % UInt32(n32)))
        var v = int31()
        while v > limit { v = int31() }
        return Int(v % n32)
    }
}

/// What the dreamer reads about each agent (Go: dreamer.DreamAgent).
struct DreamAgent: Sendable { var agentID = "", workDir = "", name = "" }

/// Nightly Dreaming: once per project per night, at a stable random moment in
/// the configured window, claims the run with the Worker and spawns a
/// print-mode CLI that loads /tsq-dreaming to update tsq/kb/ from today's
/// Memory rollup. Also starts the `tsq kb init` bootstrap. Port of packages/daemon/dreamer.
actor Dreamer {
    struct Timing: Sendable {
        var monitor: Duration = .seconds(600)
        var sessionCheck: Duration = .seconds(10)
        var sessionTimeout: Duration = .seconds(900)
    }
    static let defaultWindowStart = "01:00", defaultWindowEnd = "05:00"

    let cli: String
    let fullCommand: String
    private let windowStart: String, windowEnd: String
    private let daemonBinDir: String
    private let paths: TaskSquadPaths
    private let tmux: TmuxConnection
    private let timing: Timing
    private let now: @Sendable () -> Date
    private let post: @Sendable (_ agentID: String, _ path: String, _ body: JSONValue) async throws -> JSONValue
    private let get: @Sendable (_ agentID: String, _ path: String) async throws -> JSONValue
    private var loop: Task<Void, Never>?

    init(configuration: DaemonConfiguration, searchPath: String, daemonBinDir: String, paths: TaskSquadPaths, tmux: TmuxConnection,
         timing: Timing = Timing(), now: @escaping @Sendable () -> Date = { Date() },
         post: @escaping @Sendable (String, String, JSONValue) async throws -> JSONValue,
         get: @escaping @Sendable (String, String) async throws -> JSONValue) {
        (cli, fullCommand) = Self.resolveCLI(configuration, searchPath: searchPath)
        windowStart = configuration.dreamer.map(\.windowStart).flatMap { $0.isEmpty ? nil : $0 } ?? Self.defaultWindowStart
        windowEnd = configuration.dreamer.map(\.windowEnd).flatMap { $0.isEmpty ? nil : $0 } ?? Self.defaultWindowEnd
        self.daemonBinDir = daemonBinDir; self.paths = paths; self.tmux = tmux; self.timing = timing; self.now = now
        self.post = post; self.get = get
    }

    /// An explicit [dreamer] command wins, else [supervisor]'s; ("", "") disables Dreaming.
    static func resolveCLI(_ configuration: DaemonConfiguration, searchPath: String) -> (String, String) {
        let command: String
        if let dreamer = configuration.dreamer?.command, !dreamer.isEmpty { command = dreamer }
        else if let supervisor = configuration.supervisor?.command, !supervisor.isEmpty { command = supervisor }
        else { NSLog("[dreamer] No dreamer.command or supervisor.command configured — Dreaming disabled"); return ("", "") }
        guard let first = command.split(whereSeparator: \.isWhitespace).first.map(String.init),
              let path = ExecutableLocator.find(first, environment: ["PATH": searchPath]) else {
            NSLog("[dreamer] Dreaming CLI for %@ not found in PATH — Dreaming disabled", command); return ("", "")
        }
        return (path, command)
    }

    func start(agents: [DreamAgent]) {
        guard loop == nil, !cli.isEmpty else { return }
        let interval = timing.monitor
        loop = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: interval) } catch { return }
                for agent in agents { await self?.maybeDream(agent) }
            }
        }
    }

    func stop() async { loop?.cancel(); await loop?.value; loop = nil }

    // MARK: Eligibility (Go: maybeDream)

    static func today(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day().dateSeparator(.dash))
    }

    func maybeDream(_ agent: DreamAgent) async {
        let today = Self.today(now())
        // Dreaming never bootstraps; only `tsq kb init` creates tsq/kb.
        guard Self.kbExists(workDir: agent.workDir), !hasRun(agent.agentID, today),
              now() >= Self.triggerTime(agentID: agent.agentID, date: today, windowStart: windowStart, windowEnd: windowEnd) else { return }
        guard let projectKey = await projectKey(workDir: agent.workDir), !projectKey.isEmpty else {
            NSLog("[dreamer] %@: no git remote — skipping Dreaming", agent.name); return
        }
        let claimed: Bool
        do {
            claimed = try await post(agent.agentID, "/daemon/dream/claim", .object(["project_key": .string(projectKey), "date": .string(today)]))["claimed"] == .bool(true)
        } catch { NSLog("[dreamer] %@: claim request failed: %@", agent.name, error.localizedDescription); return } // retry later tonight
        guard claimed else { NSLog("[dreamer] %@: another daemon already claimed tonight's Dreaming for %@", agent.name, projectKey); return }
        var rollup = ""
        do { rollup = try await get(agent.agentID, "/daemon/memory/rollup?period=daily")["content"]?.string ?? "" }
        catch { NSLog("[dreamer] %@: failed to fetch memory rollup, proceeding with an empty one: %@", agent.name, error.localizedDescription) }
        // This daemon owns tonight's run: mark it attempted whatever the outcome.
        await runDreamSession(agent, projectKey: projectKey, rollup: rollup)
        writeLastRun(agent.agentID, today)
    }

    /// tsq/kb holds at least one .md file.
    static func kbExists(workDir: String) -> Bool {
        let root = URL(fileURLWithPath: workDir).appendingPathComponent("tsq/kb", isDirectory: true)
        guard let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { return false }
        for case let url as URL in files where url.pathExtension == "md" && (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            return true
        }
        return false
    }

    private func stateFile(_ agentID: String) -> URL { paths.root.appendingPathComponent("dreamer/\(agentID)/last-run") }
    private func hasRun(_ agentID: String, _ today: String) -> Bool {
        (try? String(contentsOf: stateFile(agentID), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) == today
    }
    private func writeLastRun(_ agentID: String, _ today: String) {
        let url = stateFile(agentID)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data(today.utf8).write(to: url)
    }

    /// `git remote get-url origin`, trimmed, ".git" stripped, lowercased; nil without a remote.
    private func projectKey(workDir: String) async -> String? {
        let out = ProcessOutput()
        guard let git = ExecutableLocator.find("git", environment: ["PATH": "/usr/bin:/opt/homebrew/bin:/usr/local/bin"]),
              let status = try? await NativeProcess.run(.init(executable: git, arguments: ["-C", workDir, "remote", "get-url", "origin"]), output: { channel, data in
                  if channel == .stdout { await out.append(data) }
              }), status.code == 0 else { return nil }
        var key = String(decoding: await out.data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if key.hasSuffix(".git") { key.removeLast(4) }
        return key.lowercased()
    }

    /// FNV-1a 64 of agentID+date seeds Go's math/rand: the same (agent, date) always picks
    /// the same second in [start, end) — on both daemons, across restarts.
    static func triggerTime(agentID: String, date: String, windowStart: String, windowEnd: String, timeZone: TimeZone = .current) -> Date {
        func clock(_ value: String, _ fallback: String) -> (Int, Int) {
            let parts = value.split(separator: ":")
            if parts.count == 2, (1...2).contains(parts[0].count), parts[1].count == 2, let h = Int(parts[0]), let m = Int(parts[1]), (0..<24).contains(h), (0..<60).contains(m) { return (h, m) }
            return clock(fallback, fallback)
        }
        let start = clock(windowStart, defaultWindowStart), end = clock(windowEnd, defaultWindowEnd)
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = timeZone
        let parts = date.split(separator: "-").compactMap { Int($0) }
        var components = parts.count == 3 ? DateComponents(year: parts[0], month: parts[1], day: parts[2]) : calendar.dateComponents([.year, .month, .day], from: Date())
        components.hour = start.0; components.minute = start.1
        let base = calendar.date(from: components) ?? Date()
        var window = (end.0 * 3600 + end.1 * 60) - (start.0 * 3600 + start.1 * 60)
        if window <= 0 { window += 86_400 } // wraps past midnight
        if window <= 0 { window = 1 }
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in (agentID + date).utf8 { hash ^= UInt64(byte); hash = hash &* 0x0000_0100_0000_01b3 }
        var rng = GoRand(seed: Int64(bitPattern: hash))
        return base.addingTimeInterval(TimeInterval(rng.intn(window)))
    }

    // MARK: Sessions (Go: spawn.go)

    static func shortID() -> String { (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() }

    private func runDreamSession(_ agent: DreamAgent, projectKey: String, rollup: String) async {
        let id = Self.shortID(), session = "tsq-dream-" + id
        let log = paths.logs.appendingPathComponent("dreamer/dream-\(id).log")
        do { try await spawnPrintMode(session: session, workDir: agent.workDir, prompt: Self.dreamPrompt(workDir: agent.workDir, projectKey: projectKey, rollup: rollup), log: log) }
        catch { NSLog("[dreamer] %@: failed to start Dreaming session: %@", agent.name, error.localizedDescription); return }
        let clock = ContinuousClock(), deadline = clock.now.advanced(by: timing.sessionTimeout)
        while clock.now < deadline {
            try? await Task.sleep(for: timing.sessionCheck)
            if Task.isCancelled { break }
            if (try? await tmux.run(["has-session", "-t", session])) == nil { NSLog("[dreamer] %@: Dreaming session %@ finished (exited)", agent.name, session); return }
        }
        _ = try? await tmux.run(["kill-session", "-t", session])
        NSLog("[dreamer] %@: Dreaming session %@ finished (timeout)", agent.name, session)
    }

    /// `tsq kb init`: starts the /tsq-kb-builder bootstrap and returns without waiting.
    func startKBInit(workDir: String, agentID: String) async throws -> (session: String, log: URL) {
        guard !cli.isEmpty else { throw ConfigurationError("dreamer disabled — configure [dreamer] or [supervisor] command in \(paths.config.path)") }
        let id = Self.shortID(), session = "tsq-kbinit-" + id
        let log = paths.logs.appendingPathComponent("dreamer/kbinit-\(id).log")
        do { try await spawnPrintMode(session: session, workDir: workDir, prompt: Self.initPrompt(workDir: workDir, agentID: agentID), log: log) }
        catch { throw ConfigurationError("start kb init session: \(error.localizedDescription)") }
        return (session, log)
    }

    /// The spawned shell deletes the prompt file itself, so fire-and-forget callers work too.
    private func spawnPrintMode(session: String, workDir: String, prompt: String, log: URL) async throws {
        guard Supervisor.isSafeID(session) else { throw ConfigurationError("dreamer: unsafe session name \(session)") }
        try FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("# TaskSquad Dreaming log\n# session=\(session)  work_dir=\(workDir)\n# started=\(GoTime.rfc3339(Date()))\n\n".utf8).write(to: log)
        let promptFile = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-dream-\(Self.shortID()).prompt")
        try Data(ProviderKind.detect(command: fullCommand, override: "").formatPrompt(prompt).utf8).write(to: promptFile)
        let shell = Supervisor.printModeCommand(cli: cli, fullCommand: fullCommand, promptFile: promptFile.path, logFile: log.path, daemonBinDir: daemonBinDir)
            + "; rm -f " + promptFile.path
        do { _ = try await tmux.run(["new-session", "-d", "-s", session, "-c", workDir, "sh", "-c", shell]) }
        catch { try? FileManager.default.removeItem(at: promptFile); throw ConfigurationError("tmux new-session: \(error.localizedDescription)") }
    }

    static func dreamPrompt(workDir: String, projectKey: String, rollup: String) -> String {
        """
        You are TaskSquad Dreaming: a nightly background job that keeps a project's git-tracked knowledge base in sync with today's Memory activity.

        Working directory: \(workDir)
        Project key:       \(projectKey)

        Today's memory rollup:
        \(rollup.isEmpty ? "(no memory activity recorded today)" : rollup)

        Load /tsq-dreaming and follow its instructions: walk the rollup above fact-by-fact, make small targeted edits to the relevant tsq/kb/*.md file(s), then commit and push.
        """
    }

    static func initPrompt(workDir: String, agentID: String) -> String {
        """
        You are bootstrapping a project knowledge base for TaskSquad Dreaming.

        Working directory: \(workDir)
        Agent ID:          \(agentID)

        Load /tsq-kb-builder and follow its instructions to build tsq/kb/ from scratch, then commit and push.
        """
    }
}

/// `tsq kb init` entry point for the command line (Go: dreamer.RunInit).
public enum KnowledgeBaseInit {
    public static func start(configuration: DaemonConfiguration, workDir: String, agentID: String, paths: TaskSquadPaths,
                             environment: [String: String], tmux: TmuxConnection) async throws -> (session: String, log: URL) {
        let binDir = URL(fileURLWithPath: CommandLine.arguments.first ?? "").deletingLastPathComponent().path
        let dreamer = Dreamer(configuration: configuration, searchPath: environment["PATH"] ?? "", daemonBinDir: binDir, paths: paths, tmux: tmux,
                              post: { _, _, _ in .object([:]) }, get: { _, _ in .object([:]) })
        return try await dreamer.startKBInit(workDir: workDir, agentID: agentID)
    }
}

private actor ProcessOutput {
    var data = Data()
    func append(_ chunk: Data) { data.append(chunk) }
}

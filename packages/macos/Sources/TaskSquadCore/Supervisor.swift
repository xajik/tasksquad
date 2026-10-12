import Foundation

/// What the supervisor reads about each agent (Go: supervisor.MonitoredAgent).
struct SupervisedAgent: Sendable {
    var name = "", agentID = "", mode = "", taskID = "", tmuxSession = "", sessionID = "", workDir = "", logPath = ""
    var lastActivityAt: Date?
}

/// Spawns a print-mode CLI in a `tsq-sup-<task>` tmux session when a running
/// task has had no activity for 10 minutes, then reports its verdict to the
/// task thread. Port of packages/daemon/supervisor.
actor Supervisor {
    enum VerdictStatus: String, Sendable { case workingFine = "working_fine", resolved, cannotHelp = "cannot_help" }
    struct Verdict: Sendable, Equatable { var status: String, summary: String, found: String, action: String }
    struct Timing: Sendable {
        var inactivity: Duration = .seconds(600)
        var check: Duration = .seconds(60)
        var supervisorTimeout: Duration = .seconds(300)
        var orphanCleanup: Duration = .seconds(12 * 3600)
        var sessionCheck: Duration = .seconds(5)
        var verdictPoll: Duration = .milliseconds(100)
        var flushDelay: Duration = .milliseconds(500)
    }

    static let maxFailures = 5
    static let maxRawOutputLines = 50
    static let maxEscalationLogLines = 150

    let cli: String
    let fullCommand: String
    private let daemonBinDir: String
    private let paths: TaskSquadPaths
    private let tmux: TmuxConnection
    private let timing: Timing
    private let post: @Sendable (_ agentID: String, _ path: String, _ body: JSONValue) async throws -> JSONValue
    private let attachScreenshot: @Sendable (_ agentID: String, _ sessionID: String, _ messageID: String, _ png: Data) async throws -> Void
    /// Renders a tmux session to PNG; nil when unavailable (text capture is used instead).
    private let screenshot: @Sendable (_ session: String) async -> Data?
    private let track: @Sendable (_ event: String, _ properties: [String: JSONValue]) -> Void

    private var activeForTask: Set<String> = []
    private var lastAttempt: [String: Date] = [:]
    private var failCount: [String: Int] = [:]
    private var waitingVerdict: Set<String> = []
    private var verdicts: [String: Verdict] = [:]
    private var agents: @Sendable () async -> [SupervisedAgent] = { [] }
    private var loop: Task<Void, Never>?
    private var spawns: [String: Task<Void, Never>] = [:]

    init(command: String?, searchPath: String, daemonBinDir: String, paths: TaskSquadPaths, tmux: TmuxConnection, timing: Timing = Timing(),
         post: @escaping @Sendable (String, String, JSONValue) async throws -> JSONValue,
         attachScreenshot: @escaping @Sendable (String, String, String, Data) async throws -> Void = { _, _, _, _ in },
         screenshot: @escaping @Sendable (String) async -> Data? = { _ in nil },
         track: @escaping @Sendable (String, [String: JSONValue]) -> Void = { _, _ in }) {
        (cli, fullCommand) = Self.resolveCLI(command: command, searchPath: searchPath)
        self.daemonBinDir = daemonBinDir; self.paths = paths; self.tmux = tmux; self.timing = timing
        self.post = post; self.attachScreenshot = attachScreenshot; self.screenshot = screenshot; self.track = track
    }

    /// ("", "") when unconfigured, empty, or the binary is not on PATH (supervisor disabled).
    static func resolveCLI(command: String?, searchPath: String) -> (String, String) {
        guard let command else { NSLog("[supervisor] No [supervisor] section in config — supervisor disabled"); return ("", "") }
        guard let first = command.split(whereSeparator: \.isWhitespace).first.map(String.init) else {
            NSLog("[supervisor] supervisor.command is empty — supervisor disabled"); return ("", "")
        }
        guard let path = ExecutableLocator.find(first, environment: ["PATH": searchPath]) else {
            NSLog("[supervisor] supervisor CLI %@ not found in PATH — supervisor disabled", first); return ("", "")
        }
        return (path, command)
    }

    // MARK: Monitor (Go: Monitor)

    func start(agents: @escaping @Sendable () async -> [SupervisedAgent]) {
        self.agents = agents
        guard loop == nil, !cli.isEmpty else { return }
        let timing = timing
        loop = Task { [weak self] in
            await self?.cleanOrphans()
            var sinceCleanup = Duration.zero
            while !Task.isCancelled {
                do { try await Task.sleep(for: timing.check) } catch { return }
                await self?.checkInactivity()
                sinceCleanup += timing.check
                if sinceCleanup >= timing.orphanCleanup { sinceCleanup = .zero; await self?.cleanOrphans() }
            }
        }
    }

    func stop() async {
        loop?.cancel(); await loop?.value; loop = nil
        let running = Array(spawns.values)
        for task in running { task.cancel() }
        for task in running { await task.value }
    }

    func checkInactivity() async {
        let now = Date()
        for agent in await agents() {
            guard agent.mode == "running" || agent.mode == "wrapping_up", !agent.taskID.isEmpty,
                  // stdout-pipe providers have no session to inspect or send keys to.
                  !agent.tmuxSession.isEmpty, !activeForTask.contains(agent.taskID) else { continue }
            if let last = lastAttempt[agent.taskID], now.timeIntervalSince(last) < timing.inactivity.inSeconds { continue }
            guard let activity = agent.lastActivityAt, now.timeIntervalSince(activity) >= timing.inactivity.inSeconds else { continue }
            NSLog("[supervisor] Agent %@ task %@ inactive — spawning supervisor", agent.name, agent.taskID)
            activeForTask.insert(agent.taskID)
            lastAttempt[agent.taskID] = now
            track("supervisor_spawned", ["task_id": .string(agent.taskID), "agent_name": .string(agent.name),
                                         "inactivity_mins": .number(timing.inactivity.inSeconds / 60)])
            launch(agent)
        }
    }

    private func launch(_ agent: SupervisedAgent) {
        spawns[agent.taskID] = Task { [weak self] in
            await self?.spawn(agent)
            await self?.spawnFinished(agent.taskID)
        }
    }

    private func spawnFinished(_ taskID: String) {
        activeForTask.remove(taskID)
        spawns[taskID] = nil
    }

    // MARK: Hook entry points (Go: SupervisorReporter)

    /// POST /hooks/supervisor delivers the verdict to the waiting spawn; duplicates are dropped.
    func handleVerdict(taskID: String, status: String, summary: String, found: String, action: String) {
        guard waitingVerdict.contains(taskID) else {
            NSLog("[supervisor] HandleVerdict: no active session for task %@ (already done or unknown)", taskID); return
        }
        guard verdicts[taskID] == nil else { NSLog("[supervisor] HandleVerdict: duplicate verdict for task %@ — ignoring", taskID); return }
        verdicts[taskID] = Verdict(status: status, summary: summary, found: found, action: action)
    }

    /// The monitored agent's Stop hook fired. Go kills `tsq-sup-<first 8 of task>`,
    /// which never matches the `tsq-sup-<task>` spawn uses for full ULIDs; kept as is.
    func cancelForTask(_ taskID: String) async {
        guard !taskID.isEmpty else { return }
        let session = "tsq-sup-" + taskID.prefix(8)
        if (try? await tmux.run(["has-session", "-t", session])) != nil {
            _ = try? await tmux.run(["kill-session", "-t", session])
            NSLog("[supervisor] CancelForTask: killed %@ (agent stop received for task %@)", session, taskID)
        }
        activeForTask.remove(taskID)
        failCount[taskID] = nil
    }

    struct TriggerError: LocalizedError { let errorDescription: String? }

    /// Portal "run supervisor now": ignores the inactivity timeout.
    func triggerForTask(_ taskID: String) async throws {
        guard !cli.isEmpty else { throw TriggerError(errorDescription: "supervisor disabled — no CLI configured") }
        guard !activeForTask.contains(taskID) else { throw TriggerError(errorDescription: "supervisor already active for task \(taskID)") }
        guard let target = await agents().first(where: { $0.taskID == taskID }) else {
            throw TriggerError(errorDescription: "no agent currently running task \(taskID)")
        }
        guard !activeForTask.contains(taskID) else { throw TriggerError(errorDescription: "supervisor already active for task \(taskID)") }
        activeForTask.insert(taskID)
        lastAttempt[taskID] = Date()
        track("supervisor_spawned", ["task_id": .string(taskID), "agent_name": .string(target.name), "manual": .bool(true)])
        launch(target)
    }

    // MARK: Spawn (Go: spawn.go)

    private static let safeID = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,32}$")
    static func isSafeID(_ id: String) -> Bool {
        safeID.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) != nil && !id.contains("\n")
    }

    func logPath(taskID: String) -> URL { paths.logs.appendingPathComponent("supervisor/\(taskID).log") }

    private func spawn(_ agent: SupervisedAgent) async {
        let taskID = agent.taskID
        guard Self.isSafeID(taskID) else { NSLog("[supervisor] Rejecting unsafe taskID %@", taskID); return }
        let session = "tsq-sup-" + taskID
        let supLog = logPath(taskID: taskID)
        do { try FileManager.default.createDirectory(at: supLog.deletingLastPathComponent(), withIntermediateDirectories: true) }
        catch { NSLog("[supervisor] Failed to create log dir: %@", error.localizedDescription); return }

        let (snapshot, isImage) = await captureSnapshot(session: agent.tmuxSession, supLog: supLog, taskID: taskID)
        let context = Self.contextBlock(agentName: agent.name, taskID: taskID, tmuxSession: agent.tmuxSession, logPath: agent.logPath,
                                        troubleshootingPath: troubleshootingFile(workDir: agent.workDir), snapshot: snapshot, isImage: isImage)
        let started = GoTime.rfc3339(Date())
        let header = "# TaskSquad Supervisor Log\n# agent=\(agent.name)  task_id=\(taskID)\n# started=\(started)\n\n--- CONTEXT ---\n\(context)\n\n--- OUTPUT ---\n"
        try? Data(header.utf8).write(to: supLog)

        let prompt = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-sup-\(UUID().uuidString).prompt")
        let formatted = ProviderKind.detect(command: fullCommand, override: "").formatPrompt(context)
        do { try Data(formatted.utf8).write(to: prompt) } catch { NSLog("[supervisor] Failed to write prompt file: %@", error.localizedDescription); return }
        defer { try? FileManager.default.removeItem(at: prompt) }

        let shell = Self.printModeCommand(cli: cli, fullCommand: fullCommand, promptFile: prompt.path, logFile: supLog.path, daemonBinDir: daemonBinDir)
        do {
            try paths.createRoot()
            _ = try await tmux.run(["new-session", "-d", "-s", session, "-c", paths.root.path, "sh", "-c", shell])
        } catch { NSLog("[supervisor] Failed to start tmux session %@: %@", session, error.localizedDescription); return }
        NSLog("[supervisor] Session %@ started for task %@", session, taskID)

        guard let verdict = await waitForVerdictOrKill(taskID: taskID, session: session) else {
            appendToLog(supLog, "\n--- SUPERVISOR TIMEOUT/EXIT: \(GoTime.rfc3339(Date())) ---\n")
            failCount[taskID, default: 0] += 1
            let count = failCount[taskID]!
            NSLog("[supervisor] Session %@ ended without verdict (attempt %d/%d)", session, count, Self.maxFailures)
            track("supervisor_timeout", ["task_id": .string(taskID), "attempt_count": .number(Double(count))])
            // Post the raw CLI output so the thread reflects what the supervisor did without `tsq report`.
            if let output = Self.readOutput(supLog) { await reportToWorker(agent, body: output) }
            if count >= Self.maxFailures {
                failCount[taskID] = 0
                track("supervisor_escalated", ["task_id": .string(taskID), "failures": .number(Double(count))])
                await escalate(taskID: taskID, agentID: agent.agentID, attempts: count)
            }
            return
        }
        appendToLog(supLog, "\n--- SUPERVISOR COMPLETE: \(GoTime.rfc3339(Date())) ---\n")
        failCount[taskID] = 0
        track("supervisor_verdict", ["task_id": .string(taskID), "verdict": .string(verdict.status)])
        if verdict.status == VerdictStatus.workingFine.rawValue {
            await notifyProgress(taskID: taskID, agentID: agent.agentID, message: "Task is running well — picked up and in progress")
        } else {
            await reportToWorker(agent, body: "[Supervisor] \(verdict.summary)\nStatus: \(verdict.status)\nFound: \(verdict.found)\nAction: \(verdict.action)")
        }
    }

    private func waitForVerdictOrKill(taskID: String, session: String) async -> Verdict? {
        waitingVerdict.insert(taskID); verdicts[taskID] = nil
        defer { waitingVerdict.remove(taskID); verdicts[taskID] = nil }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timing.supervisorTimeout)
        var nextSessionCheck = clock.now.advanced(by: timing.sessionCheck)
        while !Task.isCancelled {
            if let verdict = verdicts[taskID] {
                try? await Task.sleep(for: timing.flushDelay) // let output flush
                _ = try? await tmux.run(["kill-session", "-t", session])
                return verdict
            }
            if clock.now >= deadline {
                _ = try? await tmux.run(["kill-session", "-t", session])
                NSLog("[supervisor] Session %@ timed out", session)
                return nil
            }
            if clock.now >= nextSessionCheck {
                nextSessionCheck = clock.now.advanced(by: timing.sessionCheck)
                // Print mode: the CLI exits when done, ending the session.
                if (try? await tmux.run(["has-session", "-t", session])) == nil {
                    NSLog("[supervisor] Session %@: process exited without calling /hooks/supervisor", session)
                    return nil
                }
            }
            try? await Task.sleep(for: timing.verdictPoll)
        }
        _ = try? await tmux.run(["kill-session", "-t", session])
        return nil
    }

    /// Kills `tsq-sup-*` sessions this run does not manage (previous runs, crashes).
    func cleanOrphans() async {
        guard let output = try? await tmux.run(["list-sessions", "-F", "#{session_name}"]) else { return }
        for line in output.split(separator: "\n") {
            let name = line.trimmingCharacters(in: .whitespaces)
            guard name.hasPrefix("tsq-sup-"), !activeForTask.contains(String(name.dropFirst(8))) else { continue }
            _ = try? await tmux.run(["kill-session", "-t", name])
            NSLog("[supervisor] Orphan cleanup: killed %@", name)
        }
    }

    private static let ansiEscape = try! NSRegularExpression(pattern: "\u{1b}(\\[[0-9;?]*[A-Za-z]|\\][^\u{07}]*(\u{07}|\u{1b}\\\\)|\\(B|[0-9A-Za-z])")

    /// Strips ANSI sequences and keeps only what follows the last carriage return (Go: cleanLine).
    static func cleanLine(_ text: String) -> String {
        var s = text
        if let cr = s.range(of: "\r", options: .backwards) { s = String(s[cr.upperBound...]) }
        s = ansiEscape.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: "")
        while let last = s.unicodeScalars.last, last == " " || last == "\t" { s.unicodeScalars.removeLast() }
        return s
    }

    private func captureSnapshot(session: String, supLog: URL, taskID: String) async -> (String, Bool) {
        guard !session.isEmpty else { return ("", false) }
        if let png = await screenshot(session) {
            let url = supLog.deletingLastPathComponent().appendingPathComponent(taskID + "-snapshot.png")
            if (try? png.write(to: url)) != nil { return (url.path, true) }
        }
        let pane = (try? await tmux.run(["capture-pane", "-t", session, "-p", "-S", "-50"])) ?? ""
        return (Self.cleanLine(pane), false)
    }

    private func troubleshootingFile(workDir: String) -> String {
        var project = RunArtifacts.sanitize(Self.goBase(workDir))
        if project.isEmpty || project == "." { project = "default" }
        let folder = paths.root.appendingPathComponent("projects/\(project)", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("troubleshooting.md").path
    }

    /// Go's filepath.Base: last element without trailing slashes; "" → ".", all slashes → "/".
    static func goBase(_ path: String) -> String {
        guard !path.isEmpty else { return "." }
        var trimmed = Substring(path)
        while trimmed.count > 1, trimmed.hasSuffix("/") { trimmed.removeLast() }
        if trimmed == "/" { return "/" }
        return String(trimmed.split(separator: "/", omittingEmptySubsequences: false).last ?? trimmed)
    }

    /// Go's %q for the agent name.
    private static func quoted(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    static func contextBlock(agentName: String, taskID: String, tmuxSession: String, logPath: String,
                             troubleshootingPath: String, snapshot: String, isImage: Bool) -> String {
        let session = tmuxSession.isEmpty ? "(none — session may have crashed)" : tmuxSession
        let log = logPath.isEmpty ? "(no run log available)" : logPath
        var label = "Terminal snapshot (last 50 lines captured at supervisor start):"
        var section = "(session not available)"
        if !snapshot.isEmpty {
            if isImage {
                label = "Terminal screenshot (captured at supervisor start):"
                section = "View this image with your Read tool to see the terminal's actual colors and layout:\n\(snapshot)"
            } else { section = snapshot }
        }
        return """
        You are a TaskSquad Supervisor. The agent below has been in "running" state for over 10 minutes with no activity.

        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        CONTEXT
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        Agent:        \(quoted(agentName))
        Task ID:      \(taskID)
        tmux session: \(session)
        Run log:      \(log)
        Past fixes:   \(troubleshootingPath)
        Hooks port:   7374

        \(label)
        ────────────────────────────────────────────────────────
        \(section)
        ────────────────────────────────────────────────────────

        Known blocking patterns (check these first):
        - Gemini rate limit: "Usage limit reached for <model>. Access resets at HH:MM"
          followed by "● 1. Keep trying   2. Stop" → send "2" to stop gracefully.
        - Claude "❯ Result?" prompt → send "done" to complete the current turn.

        Load /tsq-supervisor and follow its instructions to perform the health check.

        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        MANDATORY FINAL STEP — do not skip this
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        You MUST call tsq report as the very last action, regardless of outcome:

          tsq report --task \(taskID) --status <status> --summary "<one line>"

          status values: resolved | working_fine | cannot_help
          - resolved     → you took action and unblocked the agent
          - working_fine → agent is healthy, nothing to do
          - cannot_help  → you inspected but could not unblock

        The daemon uses this call to know you are finished. If you exit without
        calling tsq report, the session is counted as a failure.
        """
    }

    /// POSIX shell quoting like al.essio.dev/pkg/shellescape.Quote.
    static func shellQuote(_ value: String) -> String {
        if value.isEmpty { return "''" }
        if value.range(of: #"[^\w@%+=:,./-]"#, options: .regularExpression) == nil { return value }
        return "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    /// Runs the CLI in print mode with the prompt on stdin, appending output to the log (Go: printModeCmd).
    static func printModeCommand(cli: String, fullCommand: String, promptFile: String, logFile: String, daemonBinDir: String) -> String {
        let base = URL(fileURLWithPath: cli).lastPathComponent
        let pathPrefix = daemonBinDir.isEmpty ? "" : "PATH=\(daemonBinDir):$PATH "
        if base == "codex" {
            let prefix = daemonBinDir.isEmpty ? "" : "PATH=" + shellQuote(daemonBinDir) + ":$PATH "
            return "\(prefix)\(fullCommand) exec -c notify=[] --sandbox workspace-write - < \(shellQuote(promptFile)) >> \(shellQuote(logFile)) 2>&1"
        }
        if base.hasPrefix("claude") {
            return "\(pathPrefix)cat \(promptFile) | \(cli) -p --dangerously-skip-permissions >> \(logFile) 2>&1"
        }
        return "\(pathPrefix)cat \(promptFile) | \(fullCommand) >> \(logFile) 2>&1"
    }

    // MARK: Reports (Go: report.go)

    private func appendToLog(_ url: URL, _ text: String) {
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data(text.utf8))
    }

    /// The CLI output after the last `--- OUTPUT ---`, without daemon markers, last 50 lines.
    static func readOutput(_ url: URL) -> String? {
        guard let content = try? String(contentsOf: url, encoding: .utf8), !content.isEmpty,
              let marker = content.range(of: "--- OUTPUT ---\n", options: .backwards) else { return nil }
        var output = String(content[marker.upperBound...])
        if let end = output.range(of: "\n--- SUPERVISOR") { output = String(output[..<end.lowerBound]) }
        output = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard output.utf8.count >= 10 else { return nil }
        let lines = output.components(separatedBy: "\n")
        if lines.count > maxRawOutputLines { output = "…\n" + lines.suffix(maxRawOutputLines).joined(separator: "\n") }
        return output
    }

    static func readLastLines(_ url: URL, max: Int) -> String {
        guard let content = try? String(contentsOf: url, encoding: .utf8), !content.isEmpty else { return "" }
        var trimmed = content
        while trimmed.hasSuffix("\n") { trimmed.removeLast() }
        return trimmed.components(separatedBy: "\n").suffix(max).joined(separator: "\n")
    }

    /// Posts to the task thread, then attaches a fresh screenshot of the agent's terminal.
    private func reportToWorker(_ agent: SupervisedAgent, body: String) async {
        let response: JSONValue
        do { response = try await post(agent.agentID, "/daemon/supervisor/report", .object(["task_id": .string(agent.taskID), "body": .string(body)])) }
        catch { NSLog("[supervisor] Failed to post report for task %@: %@", agent.taskID, error.localizedDescription); return }
        guard let messageID = response["message_id"]?.string, !messageID.isEmpty, !agent.sessionID.isEmpty, !agent.tmuxSession.isEmpty,
              let png = await screenshot(agent.tmuxSession) else { return }
        do { try await attachScreenshot(agent.agentID, agent.sessionID, messageID, png) }
        catch { NSLog("[supervisor] Failed to attach closing screenshot for task %@: %@", agent.taskID, error.localizedDescription) }
    }

    private func notifyProgress(taskID: String, agentID: String, message: String) async {
        do { _ = try await post(agentID, "/daemon/supervisor/report", .object(["task_id": .string(taskID), "body": .string("[Supervisor] " + message), "type": .string("progress")])) }
        catch { NSLog("[supervisor] Failed to post progress for task %@: %@", taskID, error.localizedDescription) }
    }

    private func escalate(taskID: String, agentID: String, attempts: Int) async {
        var body = "[Supervisor] Task has been stuck for \(attempts) supervision cycles (~\(Self.goDuration(minutes: attempts * 10))) with no resolution. "
            + "Manual intervention required — check `tmux ls` or restart the agent."
        let tail = Self.readLastLines(logPath(taskID: taskID), max: Self.maxEscalationLogLines)
        if !tail.isEmpty { body += "\n\nSupervisor log (last \(Self.maxEscalationLogLines) lines):\n```\n\(tail)\n```" }
        do { _ = try await post(agentID, "/daemon/supervisor/report", .object(["task_id": .string(taskID), "body": .string(body), "type": .string("escalation")])) }
        catch { NSLog("[supervisor] Failed to post escalation for task %@: %@", taskID, error.localizedDescription) }
    }

    /// Go's Duration.String for whole minutes, e.g. 50m0s, 1h0m0s.
    static func goDuration(minutes: Int) -> String {
        minutes >= 60 ? "\(minutes / 60)h\(minutes % 60)m0s" : "\(minutes)m0s"
    }
}

private extension Duration {
    var inSeconds: Double { Double(components.seconds) + Double(components.attoseconds) / 1e18 }
}

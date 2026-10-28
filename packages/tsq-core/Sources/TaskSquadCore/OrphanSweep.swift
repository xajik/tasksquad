import Foundation

/// Kills task tmux sessions the server no longer considers live: on startup and
/// hourly. Port of packages/daemon/orphan/orphan.go.
actor OrphanSweep {
    struct SessionState: Sendable, Equatable {
        var taskID = "", taskStatus = "", sessionStatus = ""
    }
    private let api: WorkerAPI
    private let tokens: any TokenProvider
    private let tmux: TmuxConnection
    private let interval: Duration
    private let report: @Sendable (String) -> Void
    private var loop: Task<Void, Never>?
    private var cachedStates: [String: SessionState] = [:]
    /// Whether a local agent owns the named tmux session; nil disables the check.
    private let tracked: (@Sendable (String) async -> Bool)?
    private var created: [String: Date] = [:]
    /// Sessions created before this sweep existed belong to a previous daemon
    /// process and need no grace period.
    private let startedAt = Date()

    /// A just-created task session is skipped: tmux new-session runs before the
    /// agent records the session name (Go: untrackedGrace).
    static let untrackedGrace: TimeInterval = 120

    /// `tracked` makes the sweep also kill task sessions no local agent owns (Go:
    /// OrphanController.WithTracked). Agent state is in memory, so after a daemon
    /// restart the previous process's sessions are unreachable; left running, a CLI
    /// there would hold the provider session the next spawn resumes.
    init(api: WorkerAPI, tokens: any TokenProvider, tmux: TmuxConnection, interval: Duration = .seconds(3600),
         tracked: (@Sendable (String) async -> Bool)? = nil, report: @escaping @Sendable (String) -> Void) {
        self.api = api; self.tokens = tokens; self.tmux = tmux; self.interval = interval; self.tracked = tracked; self.report = report
    }

    /// Whether task session tsq-<id> is unowned and was created by a previous
    /// daemon process (before `startedAt`) or before the grace period.
    static func isUntracked(created: Date?, now: Date, startedAt: Date, owned: Bool) -> Bool {
        guard let created, created < startedAt || now.timeIntervalSince(created) >= untrackedGrace else { return false }
        return !owned
    }

    func start() {
        guard loop == nil else { return }
        let interval = interval
        loop = Task { [weak self] in
            await self?.clean()
            while !Task.isCancelled {
                do { try await Task.sleep(for: interval) } catch { return }
                await self?.clean()
            }
        }
    }

    func stop() async {
        loop?.cancel(); await loop?.value; loop = nil
    }

    /// Auxiliary sessions (Portals, supervisor, short-term memory, dreamer,
    /// KB bootstrap) have their own lifecycles and are never swept.
    static func isTaskSessionName(_ name: String) -> Bool {
        guard name.hasPrefix("tsq-") else { return false }
        return !["tsq-sup-", "tsq-portal-", "tsq-stm-", "tsq-dream-", "tsq-kbinit-"].contains { name.hasPrefix($0) }
    }

    static func isOrphan(_ state: SessionState) -> Bool {
        state.taskStatus == "done" || state.taskStatus == "failed"
    }

    func clean() async {
        var sessionIDs = await listTaskSessions()
        guard !sessionIDs.isEmpty else { Log.debug("[orphan] no tsq-* sessions found"); return }
        Log.info("[orphan] checking \(sessionIDs.count) sessions")
        if let tracked {
            var live: [String] = []
            for id in sessionIDs {
                if Self.isUntracked(created: created[id], now: Date(), startedAt: startedAt, owned: await tracked("tsq-" + id)) {
                    Log.info("[orphan] tsq-\(id) is not owned by any agent of this daemon")
                    await kill(id)
                } else {
                    live.append(id)
                }
            }
            sessionIDs = live
            guard !sessionIDs.isEmpty else { return }
        }
        let states: [String: SessionState]
        do { states = try await sessionStates(sessionIDs) } catch {
            report("[orphan] failed to get session states: \(error.localizedDescription)")
            return
        }
        for id in sessionIDs {
            if let state = states[id], !Self.isOrphan(state) { continue }
            await kill(id)
        }
        Log.info("[orphan] cleanup complete: \(sessionIDs.count) sessions checked")
    }

    /// Session IDs (without the `tsq-` prefix). A missing tmux server means none.
    private func listTaskSessions() async -> [String] {
        guard let output = try? await tmux.run(["list-sessions", "-F", "#{session_name} #{session_created}"]) else { return [] }
        created = [:]
        var ids: [String] = []
        for line in output.split(separator: "\n") {
            let fields = line.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 1).map(String.init)
            guard let name = fields.first, Self.isTaskSessionName(name) else { continue }
            let id = String(name.dropFirst(4))
            if fields.count > 1, let seconds = TimeInterval(fields[1]) { created[id] = Date(timeIntervalSince1970: seconds) }
            ids.append(id)
        }
        return ids
    }

    private func sessionStates(_ ids: [String]) async throws -> [String: SessionState] {
        let token = try await tokens.token(forceRotation: false)
        let result = try await api.send(path: "/daemon/session/state", token: token,
                                        body: .object(["sessions": .array(ids.map(JSONValue.string))]))
        // The Worker always answers with `states`. Without it every session would
        // look unknown and be killed, so treat that as a failed lookup instead.
        guard let decoded = try? JSONDecoder().decode(JSONValue.self, from: result.data), case .object(let root) = decoded,
              case .object(let raw)? = root["states"] else { throw ConfigurationError("session state response has no states") }
        var states: [String: SessionState] = [:]
        for (id, value) in raw {
            guard case .object(let fields) = value else { continue }
            func text(_ key: String) -> String { if case .string(let s)? = fields[key] { s } else { "" } }
            states[id] = SessionState(taskID: text("task_id"), taskStatus: text("task_status"), sessionStatus: text("session_status"))
        }
        cachedStates = states
        return states
    }

    private func kill(_ sessionID: String) async {
        _ = try? await tmux.run(["kill-session", "-t", "=tsq-" + sessionID])
        Log.info("[orphan] killed orphaned session: tsq-\(sessionID)")
        guard let taskID = cachedStates[sessionID]?.taskID, !taskID.isEmpty else { return }
        let supervisor = "=tsq-sup-" + taskID
        if (try? await tmux.run(["has-session", "-t", supervisor])) != nil {
            _ = try? await tmux.run(["kill-session", "-t", supervisor])
            Log.info("[orphan] killed orphaned supervisor: tsq-sup-\(taskID)")
        }
    }
}

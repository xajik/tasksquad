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

    init(api: WorkerAPI, tokens: any TokenProvider, tmux: TmuxConnection, interval: Duration = .seconds(3600),
         report: @escaping @Sendable (String) -> Void) {
        self.api = api; self.tokens = tokens; self.tmux = tmux; self.interval = interval; self.report = report
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
        let sessionIDs = await listTaskSessions()
        guard !sessionIDs.isEmpty else { return }
        NSLog("[orphan] checking %d sessions", sessionIDs.count)
        let states: [String: SessionState]
        do { states = try await sessionStates(sessionIDs) } catch {
            report("[orphan] failed to get session states: \(error.localizedDescription)")
            return
        }
        for id in sessionIDs {
            if let state = states[id], !Self.isOrphan(state) { continue }
            await kill(id)
        }
        NSLog("[orphan] cleanup complete: %d sessions checked", sessionIDs.count)
    }

    /// Session IDs (without the `tsq-` prefix). A missing tmux server means none.
    private func listTaskSessions() async -> [String] {
        guard let output = try? await tmux.run(["list-sessions", "-F", "#{session_name}"]) else { return [] }
        return output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
            .filter(Self.isTaskSessionName).map { String($0.dropFirst(4)) }
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
        NSLog("[orphan] killed orphaned session: tsq-%@", sessionID)
        guard let taskID = cachedStates[sessionID]?.taskID, !taskID.isEmpty else { return }
        let supervisor = "=tsq-sup-" + taskID
        if (try? await tmux.run(["has-session", "-t", supervisor])) != nil {
            _ = try? await tmux.run(["kill-session", "-t", supervisor])
            NSLog("[orphan] killed orphaned supervisor: tsq-sup-%@", taskID)
        }
    }
}

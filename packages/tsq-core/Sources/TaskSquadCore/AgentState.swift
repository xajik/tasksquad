import Foundation

public enum AgentMode: String, Codable, CaseIterable, Sendable {
    case idle, running, waitingInput = "waiting_input", learning = "wrapping_up"
}

public enum AgentEvent: String, CaseIterable, Sendable {
    case taskStarted = "task_started", spawnFailed = "spawn_failed", userReplied = "user_replied"
    case hookStop = "hook_stop", hookNotification = "hook_notification", learnStart = "learn_start"
    case completed, reset, userClosed = "user_closed"
}

/// `detached`: the CLI went away without finishing the task (it exited while
/// waiting for input, or a resumed process never got going). The server keeps
/// the task open and the next reply re-spawns it (Go: agentmode.StatusDetached).
public enum CompletionStatus: String, Sendable { case closed, crashed, cancelled, detached }

/// Value state owned by the engine actor. Callbacks carry a generation so output
/// from a terminated process cannot alter the next task on the same agent.
public struct AgentState: Sendable, Equatable {
    public private(set) var mode: AgentMode = .idle
    public private(set) var taskID = ""
    public private(set) var sessionID = ""
    public private(set) var cliSessionID = ""
    /// This spawn reopened the provider CLI's own session (`claude --resume <id>`).
    public private(set) var resumed = false
    public private(set) var generation: UInt64 = 0
    public private(set) var tuiBlocked = false
    public private(set) var completing = false
    public private(set) var notifyPosted = false
    public var paused = false
    public var portalActive = false
    public var pendingSteps: [String] = []
    public var executedSteps: [String] = []

    public init() { }

    public static func nextMode(from mode: AgentMode, event: AgentEvent) -> AgentMode? {
        switch (mode, event) {
        case (.idle, .taskStarted): .running
        case (_, .reset): .idle
        case (.running, .spawnFailed): .idle
        case (.running, .hookStop), (.running, .hookNotification): .waitingInput
        case (.waitingInput, .userReplied): .running
        case (.waitingInput, .learnStart): .learning
        case (.waitingInput, .userClosed): .idle
        case (.running, .completed), (.waitingInput, .completed), (.learning, .completed): .idle
        default: nil
        }
    }

    public mutating func transition(_ event: AgentEvent) throws {
        guard let next = Self.nextMode(from: mode, event: event) else {
            throw ConfigurationError("invalid transition: \(mode.rawValue) -[\(event.rawValue)]-> ? (no rule defined)")
        }
        mode = next
        tuiBlocked = false
    }

    @discardableResult public mutating func beginTask(_ id: String) throws -> UInt64 {
        try transition(.taskStarted)
        generation &+= 1
        taskID = id
        sessionID = ""
        cliSessionID = ""
        resumed = false
        completing = false
        notifyPosted = false
        pendingSteps = []; executedSteps = []
        return generation
    }

    public mutating func openedSession(_ id: String, generation expected: UInt64) -> Bool {
        guard generation == expected, mode == .running, !completing else { return false }
        sessionID = id
        return true
    }

    public mutating func pinCLISessionID(_ id: String) -> Bool {
        guard !id.isEmpty else { return true }
        if cliSessionID.isEmpty { cliSessionID = id; return true }
        return cliSessionID == id
    }

    public mutating func markResumed() { resumed = true }

    /// Ports AgentState.detachReason (agent/state.go): whether the process going
    /// away should detach the task (keep it open for a resume) instead of failing
    /// it, and whether that is because a resumed spawn never got going. A fresh
    /// spawn's mid-turn crash still fails the task.
    public func detachReason() -> (detach: Bool, resumeFailed: Bool) {
        guard !completing, !sessionID.isEmpty else { return (false, false) }
        if mode == .waitingInput { return (true, false) }
        if mode == .running, resumed, cliSessionID.isEmpty { return (true, true) }
        return (false, false)
    }

    public mutating func setTUIBlocked(_ blocked: Bool) {
        if mode == .running { tuiBlocked = blocked }
    }

    /// Atomically reserves a notification before doing any network I/O.
    /// Ports StopAndPause/SetWaitingInput in agent/session.go, which both gate
    /// strictly on ModeRunning: once already .waitingInput, a notification was
    /// already claimed for this turn, so a stray/duplicate hook must not claim
    /// a second one.
    public mutating func claimNotification(generation expected: UInt64) -> Bool {
        guard generation == expected, !completing, !notifyPosted, mode == .running else { return false }
        notifyPosted = true
        return true
    }

    public mutating func userReplied() throws {
        try transition(.userReplied)
        notifyPosted = false
    }

    public mutating func beginCompletion(generation expected: UInt64) -> Bool {
        guard generation == expected, !completing, !sessionID.isEmpty else { return false }
        completing = true
        return true
    }

    public mutating func finishCompletion(generation expected: UInt64) {
        guard generation == expected else { return }
        mode = .idle; sessionID = ""; completing = false; tuiBlocked = false
        // Go retains taskID until the next task starts; heartbeats include it even while idle.
    }

    public mutating func reset() {
        generation &+= 1
        mode = .idle; sessionID = ""; taskID = ""; cliSessionID = ""; resumed = false
        completing = false; tuiBlocked = false; notifyPosted = false
        pendingSteps = []; executedSteps = []
    }

    public func heartbeat(agentID: String, uptimeMilliseconds: Int64) -> JSONValue {
        var object: [String: JSONValue] = ["id": .string(agentID), "status": .string(mode.rawValue),
                                          "daemon_uptime_ms": .number(Double(uptimeMilliseconds))]
        if mode == .learning { object["close_step_idx"] = .number(Double(executedSteps.count)) }
        if portalActive { object["portal_active"] = .bool(true) }
        if !taskID.isEmpty { object["task_id"] = .string(taskID); object["tui_blocked"] = .bool(tuiBlocked) }
        return .object(object)
    }
}

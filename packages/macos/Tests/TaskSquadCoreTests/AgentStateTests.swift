import XCTest
@testable import TaskSquadCore

final class AgentStateTests: XCTestCase {
    func testAllReferenceTransitions() {
        let expected: [AgentMode: [AgentEvent: AgentMode]] = [
            .idle: [.taskStarted: .running, .reset: .idle],
            .running: [.spawnFailed: .idle, .hookStop: .waitingInput, .hookNotification: .waitingInput, .completed: .idle, .reset: .idle],
            .waitingInput: [.userReplied: .running, .learnStart: .learning, .userClosed: .idle, .completed: .idle, .reset: .idle],
            .learning: [.completed: .idle, .reset: .idle],
        ]
        for mode in AgentMode.allCases {
            for event in AgentEvent.allCases { XCTAssertEqual(AgentState.nextMode(from: mode, event: event), expected[mode]?[event]) }
        }
    }

    func testStopPausesInsteadOfCompletingAndRejectsStaleHooks() throws {
        var state = AgentState()
        let generation = try state.beginTask("task-one")
        XCTAssertTrue(state.openedSession("session", generation: generation))
        XCTAssertTrue(state.pinCLISessionID("cli-one"))
        XCTAssertFalse(state.pinCLISessionID("cli-two"))
        XCTAssertTrue(state.pinCLISessionID(""))
        state.setTUIBlocked(true)
        XCTAssertTrue(state.claimNotification(generation: generation))
        try state.transition(.hookStop)
        XCTAssertEqual(state.mode, .waitingInput)
        XCTAssertFalse(state.tuiBlocked)
        XCTAssertEqual(state.sessionID, "session")
        XCTAssertFalse(state.claimNotification(generation: generation))
        try state.userReplied()
        XCTAssertEqual(state.mode, .running)
        XCTAssertTrue(state.claimNotification(generation: generation))
        XCTAssertTrue(state.beginCompletion(generation: generation))
        XCTAssertFalse(state.beginCompletion(generation: generation))
        state.finishCompletion(generation: generation)
        XCTAssertEqual(state.mode, .idle)
        _ = try state.beginTask("task-two")
        XCTAssertFalse(state.openedSession("old-session", generation: generation))
        XCTAssertFalse(state.claimNotification(generation: generation))
        state.finishCompletion(generation: generation)
        XCTAssertEqual(state.taskID, "task-two")
        XCTAssertEqual(state.mode, .running)
    }

    func testLearningHeartbeatUsesServerWireNames() throws {
        var state = AgentState()
        _ = try state.beginTask("task")
        try state.transition(.hookStop)
        try state.transition(.learnStart)
        state.executedSteps = ["step-one"]
        state.portalActive = true
        let heartbeat = state.heartbeat(agentID: "agent", uptimeMilliseconds: 1234)
        XCTAssertEqual(heartbeat["status"], .string("wrapping_up"))
        XCTAssertEqual(heartbeat["close_step_idx"], .number(1))
        XCTAssertEqual(heartbeat["daemon_uptime_ms"], .number(1234))
        XCTAssertEqual(heartbeat["portal_active"], .bool(true))
    }
}

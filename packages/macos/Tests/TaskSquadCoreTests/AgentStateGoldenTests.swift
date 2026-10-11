import XCTest
@testable import TaskSquadCore

/// Go's agent/state.go transition table, dumped exhaustively (Fixtures/transitions-golden.txt),
/// plus the remaining agent/state_test.go cases.
final class AgentStateGoldenTests: XCTestCase {
    private func state(_ mode: AgentMode) -> AgentState {
        var s = AgentState()
        switch mode {
        case .idle: break
        case .running: _ = try? s.beginTask("t")
        case .waitingInput: _ = try? s.beginTask("t"); try? s.transition(.hookStop)
        case .learning: _ = try? s.beginTask("t"); try? s.transition(.hookStop); try? s.transition(.learnStart)
        }
        return s
    }

    func testEveryTransitionAndErrorMatchesGo() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil)?.appendingPathComponent("transitions-golden.txt"))
        let lines = try String(contentsOf: url, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(lines.count, AgentMode.allCases.count * AgentEvent.allCases.count)
        for line in lines {
            let f = line.components(separatedBy: "|")
            let mode = try XCTUnwrap(AgentMode(rawValue: f[0])), event = try XCTUnwrap(AgentEvent(rawValue: f[1]))
            var s = state(mode)
            XCTAssertEqual(s.mode, mode)
            do {
                try s.transition(event)
                XCTAssertEqual(s.mode.rawValue, f[2], String(line))
            } catch {
                XCTAssertEqual(f[2], "error", String(line))
                XCTAssertEqual(error.localizedDescription, f[3], String(line))
                XCTAssertEqual(s.mode, mode, "a rejected transition leaves the mode")
            }
        }
    }

    func testPinningAndTUIBlocked() throws {
        var s = AgentState()
        XCTAssertTrue(s.pinCLISessionID("")); XCTAssertTrue(s.pinCLISessionID("real-session"))
        XCTAssertTrue(s.pinCLISessionID("")); XCTAssertTrue(s.pinCLISessionID("real-session"))
        XCTAssertFalse(s.pinCLISessionID("other")); XCTAssertTrue(s.pinCLISessionID("real-session"))
        s.setTUIBlocked(true); XCTAssertFalse(s.tuiBlocked, "no-op outside running")
        s = state(.running); s.setTUIBlocked(true); XCTAssertTrue(s.tuiBlocked)
        try s.transition(.hookStop); XCTAssertFalse(s.tuiBlocked, "a successful transition clears it")
        s = state(.running); s.setTUIBlocked(true)
        XCTAssertThrowsError(try s.transition(.learnStart)); XCTAssertTrue(s.tuiBlocked, "a rejected one keeps it")
        XCTAssertFalse(AgentState().paused)
    }
}

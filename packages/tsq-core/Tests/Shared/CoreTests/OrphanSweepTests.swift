import XCTest
@testable import TaskSquadCore

private struct SweepTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "fixture-token" }
}

/// Worker double for POST /daemon/session/state.
private actor StateWorker {
    var requested: [JSONValue] = []
    let states: [String: JSONValue]?
    init(states: [String: JSONValue]?) { self.states = states }
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        guard request.path == "/daemon/session/state" else { return .init(status: 404) }
        requested.append((try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null)
        return .json(.object(states.map { ["states": .object($0)] } ?? [:]))
    }
}

final class OrphanSweepTests: PlatformTestCase {
    // Ported from packages/daemon/orphan/orphan_test.go.
    func testIsOrphanOnlyForDoneAndFailedTasks() {
        for (status, orphan) in [("done", true), ("failed", true), ("running", false), ("waiting_input", false), ("pending", false), ("", false)] {
            XCTAssertEqual(OrphanSweep.isOrphan(.init(taskStatus: status)), orphan, status)
        }
    }

    func testAuxiliarySessionsAreNeverCandidates() {
        for prefix in ["tsq-sup-", "tsq-portal-", "tsq-stm-", "tsq-dream-", "tsq-kbinit-", "personal-"] {
            XCTAssertFalse(OrphanSweep.isTaskSessionName(prefix + "123"), prefix)
        }
        XCTAssertTrue(OrphanSweep.isTaskSessionName("tsq-01SESSION"))
    }

    func testSweepKillsClosedAndUnknownSessionsAndTheirSupervisorOnly() async throws {
        guard let executable = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux")
        else { throw XCTSkip("tmux is required for orphan sweep integration tests") }
        let tmux = TmuxConnection(executable: executable, socketPath: "/tmp/tsq-test-" + UUID().uuidString + ".sock")
        for name in ["tsq-done1", "tsq-live1", "tsq-unknown1", "tsq-sup-T1", "tsq-portal-abcd1234", "personal"] {
            _ = try await tmux.run(["-f", "/dev/null", "new-session", "-d", "-s", name, "/bin/sleep", "120"])
        }
        let worker = StateWorker(states: [
            "done1": .object(["task_id": .string("T1"), "task_status": .string("done"), "session_status": .string("closed")]),
            "live1": .object(["task_id": .string("T2"), "task_status": .string("running"), "session_status": .string("open")]),
        ])
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let sweep = OrphanSweep(api: WorkerAPI(baseURL: "http://127.0.0.1:\(port)"), tokens: SweepTokens(), tmux: tmux) { XCTFail($0) }
        await sweep.clean()
        let listed = try await tmux.run(["list-sessions", "-F", "#{session_name}"])
        _ = try? await tmux.run(["kill-server"])
        await server.stop()

        let remaining = Set(listed.split(separator: "\n").map(String.init))
        XCTAssertEqual(remaining, ["tsq-live1", "tsq-portal-abcd1234", "personal"])
        let requested = await worker.requested
        guard case .object(let body)? = requested.first, case .array(let ids)? = body["sessions"] else { return XCTFail("no state request") }
        XCTAssertEqual(Set(ids.compactMap { if case .string(let id) = $0 { id } else { nil } }), ["done1", "live1", "unknown1"])
    }

    /// A generic `{}` reply (e.g. another test's fixture) must never kill sessions.
    func testResponseWithoutStatesKillsNothing() async throws {
        guard let executable = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux")
        else { throw XCTSkip("tmux is required for orphan sweep integration tests") }
        let tmux = TmuxConnection(executable: executable, socketPath: "/tmp/tsq-test-" + UUID().uuidString + ".sock")
        _ = try await tmux.run(["-f", "/dev/null", "new-session", "-d", "-s", "tsq-keep1", "/bin/sleep", "120"])
        let worker = StateWorker(states: nil)
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let errors = ErrorLog()
        let sweep = OrphanSweep(api: WorkerAPI(baseURL: "http://127.0.0.1:\(port)"), tokens: SweepTokens(), tmux: tmux) { message in Task { await errors.add(message) } }
        await sweep.clean()
        let listed = try await tmux.run(["list-sessions", "-F", "#{session_name}"])
        _ = try? await tmux.run(["kill-server"])
        await server.stop()
        XCTAssertEqual(listed.trimmingCharacters(in: .whitespacesAndNewlines), "tsq-keep1")
    }
}

private actor ErrorLog {
    var messages: [String] = []
    func add(_ message: String) { messages.append(message) }
}

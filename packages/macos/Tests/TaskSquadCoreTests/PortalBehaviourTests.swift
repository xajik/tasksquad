import XCTest
@testable import TaskSquadCore

private struct PortalTokens2: TokenProvider { func token(forceRotation: Bool) async throws -> String { "t" } }

private actor PortalWorker {
    enum Mode { case closeNow, recover(crashed: Bool), live }
    let mode: Mode
    var assigned = false
    var opens = 0
    var closes: [(id: String, status: String)] = []
    init(_ mode: Mode) { self.mode = mode }
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        let body = (try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null
        switch request.path {
        case "/daemon/heartbeat/batch":
            var agent: [String: JSONValue] = ["agent_id": .string("p"), "next_poll_ms": .number(50)]
            if !assigned {
                assigned = true
                switch mode {
                case .closeNow, .live: agent["portal"] = .object(["id": .string("01PORTALBEHAVIOUR01")])
                case .recover(let crashed): agent["close_portal"] = .object(["id": .string("01PORTALGONE000001"), "crashed": .bool(crashed)])
                }
            }
            return .json(.object(["agents": .array([.object(agent)])]))
        case "/daemon/portal/open":
            opens += 1
            if case .closeNow = mode { return .json(.object(["close_now": .bool(true)])) }
            return .json(.object([:]))
        case "/daemon/portal/close":
            closes.append((body["portal_id"]?.string ?? "", body["status"]?.string ?? ""))
            return .json(.object([:]))
        default: return .json(.object([:]))
        }
    }
}

/// Go agent/portal.go + batch.go Portal paths not covered by PortalHostTests.
final class PortalBehaviourTests: XCTestCase {
    private func run(_ mode: PortalWorker.Mode, stopEarly: Bool = false) async throws -> (opens: Int, closes: [(id: String, status: String)], sessions: String) {
        guard let tmuxPath = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux")
        else { throw XCTSkip("tmux required") }
        let tmux = TmuxConnection(executable: tmuxPath, socketPath: "/tmp/tsq-pb-" + UUID().uuidString.prefix(8) + ".sock")
        let worker = PortalWorker(mode)
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-pb-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let hooks = try await freeLoopbackPort()
        let config = try DaemonConfiguration.parse("""
        [server]
        url = 'http://127.0.0.1:\(port)'
        [hooks]
        port = \(hooks)
        [[agents]]
        id = 'p'
        name = 'portal'
        command = '/bin/cat'
        provider = 'stdout'
        work_dir = '\(home.path)'
        """)
        let engine = DaemonEngine(configuration: config, paths: TaskSquadPaths(home: home), tokens: PortalTokens2(), tmux: tmux)
        try await engine.start()
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        if stopEarly {
            while await worker.opens == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
            try await Task.sleep(for: .milliseconds(300))
            await engine.stop()
        } else {
            while await worker.closes.isEmpty, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
            try await Task.sleep(for: .milliseconds(200))
            await engine.stop()
        }
        let sessions = (try? await tmux.run(["list-sessions", "-F", "#{session_name}"])) ?? ""
        _ = try? await tmux.run(["kill-server"])
        await server.stop()
        return (await worker.opens, await worker.closes, sessions)
    }

    func testCloseNowOnOpenReportsDoneAndLeavesNoSession() async throws {
        let r = try await run(.closeNow)
        XCTAssertEqual(r.opens, 1)
        XCTAssertEqual(r.closes.map(\.status), ["done"])
        XCTAssertFalse(r.sessions.contains("tsq-portal-"))
    }

    func testCrashRecoveryReportsFailedOrDoneWithoutALiveSession() async throws {
        for (crashed, status) in [(true, "failed"), (false, "done")] {
            let r = try await run(.recover(crashed: crashed))
            XCTAssertEqual(r.opens, 0)
            XCTAssertEqual(r.closes.map(\.id), ["01PORTALGONE000001"])
            XCTAssertEqual(r.closes.map(\.status), [status])
        }
    }

    func testShutdownClosesALivePortalAndReportsDone() async throws {
        let r = try await run(.live, stopEarly: true)
        XCTAssertEqual(r.opens, 1)
        XCTAssertEqual(r.closes.map(\.status), ["done"], "Go CloseActivePortal on quit")
        XCTAssertFalse(r.sessions.contains("tsq-portal-"), "no orphaned tmux session")
    }
}

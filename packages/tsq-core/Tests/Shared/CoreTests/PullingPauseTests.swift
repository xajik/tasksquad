import XCTest
@testable import TaskSquadCore

private struct PauseTokens: TokenProvider { func token(forceRotation: Bool) async throws -> String { "t" } }

/// Offers the same task on every heartbeat and records whether a session was opened.
private actor OfferingWorker {
    var heartbeats = 0, opened = 0
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        switch request.path {
        case "/daemon/heartbeat/batch":
            heartbeats += 1
            return .json(.object(["agents": .array([.object(["agent_id": .string("a"), "next_poll_ms": .number(50),
                "task": .object(["id": .string("t1"), "subject": .string("s"), "messages": .array([])])])])]))
        case "/daemon/session/open":
            opened += 1
            return .json(.object(["session_id": .string("s1")]))
        default: return .json(.object([:]))
        }
    }
}

final class PullingPauseTests: PlatformTestCase {
    func testPausedEngineKeepsHeartbeatingButTakesNoTaskUntilResumed() async throws {
        let worker = OfferingWorker()
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-pause-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let hooks = try await freeLoopbackPort()
        let config = try DaemonConfiguration.parse("""
        [server]
        url = 'http://127.0.0.1:\(port)'
        [hooks]
        port = \(hooks)
        [[agents]]
        id = 'a'
        name = 'a'
        command = '/bin/cat'
        provider = 'stdout'
        work_dir = '\(home.path)'
        """)
        let engine = DaemonEngine(configuration: config, paths: TaskSquadPaths(home: home), tokens: PauseTokens())
        await engine.setPullingPaused(true)
        try await engine.start()
        for _ in 0..<60 where await worker.heartbeats < 3 { try await Task.sleep(for: .milliseconds(50)) }
        let beats = await worker.heartbeats, openedWhilePaused = await worker.opened
        XCTAssertGreaterThanOrEqual(beats, 3, "paused agents stay online")
        XCTAssertEqual(openedWhilePaused, 0)
        await engine.setPullingPaused(false)
        for _ in 0..<60 where await worker.opened == 0 { try await Task.sleep(for: .milliseconds(50)) }
        let opened = await worker.opened
        XCTAssertEqual(opened, 1)
        await engine.stop()
        await server.stop()
    }
}

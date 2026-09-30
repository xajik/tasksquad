import XCTest
@testable import TaskSquadCore

private struct PortalTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "fixture-token" }
}

/// Worker double: assigns one portal to the idle agent, then (once asked)
/// sends `close_portal` the way the server does after the browser closes it.
private actor PortalWorker {
    var assigned = false
    var closeRequested = false
    var portalActiveSeen = false
    var opened: JSONValue?
    var closed: [JSONValue] = []
    func requestClose() { closeRequested = true }
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        let body = (try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null
        switch request.path {
        case "/daemon/heartbeat/batch":
            if body["agents"]?.array?.first?["portal_active"] == .bool(true) { portalActiveSeen = true }
            var agent: [String: JSONValue] = ["agent_id": .string("portal-agent"), "next_poll_ms": .number(50)]
            if !assigned { assigned = true; agent["portal"] = .object(["id": .string("01PORTALFIXTURE0001")]) }
            if closeRequested { agent["close_portal"] = .object(["id": .string("01PORTALFIXTURE0001")]) }
            return .json(.object(["agents": .array([.object(agent)])]))
        case "/daemon/portal/open":
            opened = body
            return .json(.object(["ok": .bool(true)]))
        case "/daemon/portal/close":
            closed.append(body)
            return .json(.object(["ok": .bool(true)]))
        default:
            return .json(.object([:]))
        }
    }
}

final class PortalHostTests: XCTestCase {
    func testAssignedPortalOpensTmuxReportsOpenAndClosesOnServerSignal() async throws {
        guard let executable = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux")
        else { throw XCTSkip("tmux is required for portal tests") }
        let tmux = TmuxConnection(executable: executable, socketPath: "/tmp/tsq-portal-test-" + UUID().uuidString.prefix(8) + ".sock")
        defer { Task { _ = try? await tmux.run(["kill-server"]) } }
        let worker = PortalWorker()
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        // Stdout provider: no hook listener is needed, so the test owns no fixed port.
        let config = try DaemonConfiguration.parse("""
        [server]
        url = 'http://127.0.0.1:\(port)'
        [[agents]]
        id = 'portal-agent'
        name = 'Portal fixture'
        command = '/bin/cat'
        provider = 'stdout'
        work_dir = '\(home.path)'
        """)
        let engine = DaemonEngine(configuration: config, paths: TaskSquadPaths(home: home), tokens: PortalTokens(), tmux: tmux)
        try await engine.start()

        try await wait { await worker.opened != nil }
        let opened = await worker.opened
        XCTAssertEqual(opened?["portal_id"]?.string, "01PORTALFIXTURE0001")
        XCTAssertEqual(opened?["session_id"]?.string, "01PORTALFIXTURE0001")
        let sessions = try await tmux.run(["list-sessions", "-F", "#{session_name}"])
        XCTAssertTrue(sessions.contains("tsq-portal-01PORTAL"), sessions)
        try await wait { await worker.portalActiveSeen }

        await worker.requestClose()
        try await wait { await !worker.closed.isEmpty }
        let closed = await worker.closed
        XCTAssertEqual(closed.first?["status"]?.string, "done")
        let remaining = (try? await tmux.run(["list-sessions", "-F", "#{session_name}"])) ?? ""
        XCTAssertFalse(remaining.contains("tsq-portal-01PORTAL"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: "/tmp/tsq-portal-01PORTAL.fifo"))
        await engine.stop(); await server.stop()
    }

    private func wait(_ timeout: Duration = .seconds(15), until condition: () async -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !(await condition()) {
            guard ContinuousClock.now < deadline else { XCTFail("Timed out waiting for condition"); return }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
}

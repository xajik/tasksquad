import XCTest
@testable import TaskSquadCore

private struct SwiftTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "fixture-token" }
}

/// One worker both daemons poll. Go and Swift present different bearer tokens,
/// so every claim is attributed to the daemon that made it.
private actor SwitchingWorker {
    struct Claim: Equatable { let daemon: String; let task: String }
    var claims: [Claim] = []
    var closes: [String: JSONValue] = [:]
    var releaseB = false
    var baseURL = ""
    func setURL(_ value: String) { baseURL = value }
    func release() { releaseB = true }

    private func task(_ id: String) -> JSONValue {
        let message = JSONValue.object(["role": .string("user"), "body": .string("prompt for \(id)")])
        let task = JSONValue.object(["id": .string(id), "subject": .string("subject \(id)"), "messages": .array([message])])
        return .object(["agents": .array([.object(["agent_id": .string("switch-agent"), "next_poll_ms": .number(1_000), "task": task])])])
    }

    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        let daemon: String
        switch request.headers["authorization"] {
        case "Bearer tsq_cli_go_oracle": daemon = "go"
        case "Bearer fixture-token": daemon = "swift"
        default: return request.path == "/upload" ? .init() : .init(status: 401)
        }
        let body = (try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null
        switch request.path {
        case "/daemon/heartbeat/batch":
            let opened = Set(claims.map(\.task))
            if !opened.contains("task-a") { return .json(task("task-a")) }
            if releaseB, closes["task-a"] != nil, !opened.contains("task-b") { return .json(task("task-b")) }
            return .init(status: 304)
        case "/daemon/session/open":
            guard case .string(let id)? = body["task_id"] else { return .init(status: 400) }
            claims.append(Claim(daemon: daemon, task: id))
            return .json(.object(["session_id": .string("session-\(id)")]))
        case "/daemon/session/close":
            guard case .string(let session)? = body["session_id"] else { return .init(status: 400) }
            closes[String(session.dropFirst("session-".count))] = body
            return .json(.object(["message_id": .string("message-\(session)")]))
        case "/daemon/r2/presign":
            return .json(.object(["upload_url": .string(baseURL + "/upload"), "key": .string("switch/full.log"),
                                  "dek": .string(Data(repeating: 0x42, count: 32).base64EncodedString())]))
        default: return .json(.object([:]))
        }
    }
}

/// Go → Swift handover on one machine: the shared daemon.lock keeps the two
/// daemons exclusive, and the shared HOME (device-id, journal) carries over.
@MainActor final class DaemonSwitchingTests: PlatformTestCase {
    func testGoThenSwiftShareLockStateAndNeverDuplicateAClaim() async throws {
        let oracle = try goOracle()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-switch-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let script = home.appendingPathComponent("provider")
        try Data("#!/bin/sh\nprintf 'done %s\\n' \"$TSQ_TASK_ID\"\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        let worker = SwitchingWorker()
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        await worker.setURL("http://127.0.0.1:\(port)")
        let hooksPort = try await freeLoopbackPort()
        let paths = TaskSquadPaths(home: home)
        try paths.createRoot()
        try Data("""
        [server]
        url = 'http://127.0.0.1:\(port)'
        poll_interval = 1
        [hooks]
        port = \(hooksPort)
        [[agents]]
        id = 'switch-agent'
        name = 'Switch agent'
        command = '\(script.path)'
        provider = 'stdout'
        work_dir = '\(home.path)'
        """.utf8).write(to: paths.config)

        // Phase 1: the Go daemon owns the machine and finishes task A.
        let go = Process()
        go.executableURL = oracle
        go.arguments = ["daemon", paths.config.path]
        go.environment = ProcessInfo.processInfo.environment.merging(["HOME": home.path]) { $1 }
        let goOut = Pipe()
        go.standardOutput = goOut
        go.standardError = FileHandle.nullDevice
        try go.run()
        defer { if go.isRunning { go.terminate() } }
        var banner = Data() // Go's logger shares stdout; wait for the oracle's own line.
        while !String(decoding: banner, as: UTF8.self).contains("running\n") {
            let chunk = goOut.fileHandleForReading.availableData
            guard !chunk.isEmpty else { return XCTFail("Go oracle exited: \(String(decoding: banner, as: UTF8.self))") }
            banner.append(chunk)
        }
        XCTAssertThrowsError(try DaemonLock(paths: paths), "Swift must not start while Go holds daemon.lock")
        try await waitUntil("Go closes task A") { await worker.closes["task-a"] != nil }

        go.terminate()
        go.waitUntilExit()

        // Phase 2: Swift takes over the same HOME and picks up only new work.
        let deviceID = try paths.deviceID()
        let config = try DaemonConfiguration.load(from: paths.config, paths: paths)
        let engine = DaemonEngine(configuration: config, paths: paths, tokens: SwiftTokens(), appVersion: "9.9.9", onError: { _ in })
        try await engine.start()
        await worker.release()
        try await waitUntil("Swift closes task B") { await worker.closes["task-b"] != nil }
        await engine.stop()

        let claims = await worker.claims
        XCTAssertEqual(claims, [.init(daemon: "go", task: "task-a"), .init(daemon: "swift", task: "task-b")])
        let closes = await worker.closes
        XCTAssertNotNil(closes["task-a"]?["status"])
        XCTAssertEqual(closes["task-a"]?["status"], closes["task-b"]?["status"], "both daemons report the same completion status")
        XCTAssertEqual(try paths.deviceID(), deviceID)
        for id in ["task-a", "task-b"] {
            let journal = (try? Data(contentsOf: paths.root.appendingPathComponent("tasks/\(id).jsonl"))) ?? Data()
            XCTAssertFalse(journal.isEmpty, "journal for \(id)")
        }
        let relaunched = try DaemonLock(paths: paths) // released by the Swift engine for the next daemon
        withExtendedLifetime(relaunched) { }
    }

}

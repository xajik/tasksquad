import XCTest
@testable import TaskSquadCore

private struct FixtureTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "fixture-token" }
}

private actor WorkerFixture {
    var assigned = false
    var close: JSONValue?
    var uploaded = Data()
    var baseURL = ""
    var control: String?
    let key = Data(repeating: 0x42, count: 32).base64EncodedString()
    let completed: @Sendable () -> Void
    init(completed: @escaping @Sendable () -> Void) { self.completed = completed }
    func setURL(_ value: String) { baseURL = value }
    func setControl(_ value: String) { control = value }
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        if request.path != "/upload" {
            guard request.headers["authorization"] == "Bearer fixture-token" else { return .init(status: 401) }
        }
        let body = (try? JSONDecoder().decode(JSONValue.self, from: request.body)) ?? .null
        switch request.path {
        case "/daemon/heartbeat/batch":
            if let control { return .json(.object(["agents": .array([.object(["agent_id": .string("fixture-agent"), control: .bool(true)])])])) }
            if assigned { return .init(status: 304) }
            assigned = true
            let message = JSONValue.object(["role": .string("user"), "body": .string("prompt é猫  ")])
            let task = JSONValue.object(["id": .string("fixture-task"), "subject": .string("fixture subject"), "messages": .array([message])])
            let agent = JSONValue.object(["agent_id": .string("fixture-agent"), "next_poll_ms": .number(60_000), "task": task])
            return .json(.object(["agents": .array([agent])]))
        case "/daemon/session/open":
            guard request.headers["x-tsq-agent"] == "fixture-agent", body["task_id"] == .string("fixture-task") else { return .init(status: 400) }
            return .json(.object(["session_id": .string("fixture-session")]))
        case "/daemon/session/close": close = body; return .json(.object(["message_id": .string("fixture-message")]))
        case "/daemon/r2/presign":
            return .json(.object(["upload_url": .string(baseURL + "/upload"), "key": .string("fixture/full.log"), "dek": .string(key)]))
        case "/upload":
            guard request.headers["authorization"] == nil else { return .init(status: 400) }
            uploaded = request.body
            return .init()
        case "/daemon/sessions/fixture-session/attach":
            guard body["r2_log_key"] == .string("fixture/full.log") else { return .init(status: 400) }
            return .init(body: Data("{}".utf8), onSent: completed)
        default: return .init(status: 404)
        }
    }
}

@MainActor final class EngineIntegrationTests: XCTestCase {
    func testDuplicateAgentIDsFailGracefullyInsteadOfTrappingTheAgentsDictionary() async throws {
        // parse() accepts duplicate IDs (matching Go); Dictionary(uniqueKeysWithValues:)
        // in start() would otherwise trap on them instead of failing gracefully.
        var config = DaemonConfiguration()
        config.agents = [
            .init(id: "dup", name: "one", command: "/bin/echo", workDir: "/tmp", provider: "stdout"),
            .init(id: "dup", name: "two", command: "/bin/echo", workDir: "/tmp", provider: "stdout"),
        ]
        let engine = DaemonEngine(configuration: config, tokens: FixtureTokens())
        do { try await engine.start(); XCTFail("Expected duplicate ID rejection") }
        catch { XCTAssertTrue(error.localizedDescription.contains("unique ID")) }
    }

    func testTaskRunsThroughRealHTTPNativeProcessArtifactsAndEncryptedUpload() async throws {
        try await runScenario(exitCode: 0)
    }

    func testFailedProcessClosesSessionAsCrashed() async throws {
        try await runScenario(exitCode: 7)
    }

    func testShutdownDrainsOutputAndClosesSessionBeforeReleasingLock() async throws {
        try await runScenario(exitCode: 0, stopEarly: true)
    }

    func testStoppingOneAgentClosesTaskButKeepsEngineLock() async throws {
        try await runScenario(exitCode: 0, stopEarly: true, cancelOne: true)
    }

    func testServerCloseDoesNotPostDuplicateFinalReply() async throws {
        try await runScenario(exitCode: 0, stopEarly: true, control: "close")
    }

    private func runScenario(exitCode: Int, stopEarly: Bool = false, control: String? = nil, cancelOne: Bool = false) async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let script = home.appendingPathComponent("provider")
        let finish = stopEarly ? "touch running\nexec /bin/sleep 120" : "exit \(exitCode)"
        let scriptText = "#!/bin/sh\n[ \"$1\" = '-p' ] || exit 23\n[ \"$2\" = 'prompt é猫  ' ] || exit 24\nprintf '\\033[32mresult é猫\\033[0m\\n'\nprintf '%s' \"$TSQ_TASK_ID\"\n\(finish)\n"
        try Data(scriptText.utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let finished = expectation(description: "encrypted output attached to session")
        if control != nil { finished.isInverted = true }
        let fixture = WorkerFixture { finished.fulfill() }
        let server = try LocalHTTPServer { await fixture.handle($0) }
        let port = try await server.start()
        await fixture.setURL("http://127.0.0.1:\(port)")
        let hooksPort = try await freeLoopbackPort()
        let config = try DaemonConfiguration.parse("""
        [server]
        url = 'http://127.0.0.1:\(port)'
        [hooks]
        port = \(hooksPort)
        [[agents]]
        id = 'fixture-agent'
        name = 'Test agent'
        command = '\(script.path)'
        provider = 'stdout'
        work_dir = '\(home.path)'
        """)
        let paths = TaskSquadPaths(home: home)
        let recorder = AnalyticsRecorder()
        let analytics = Analytics(enabled: true, apiKey: "test-key", deviceID: "device-1", appVersion: "9.9.9", transport: recorder, flushInterval: .seconds(3600))
        let engine = DaemonEngine(configuration: config, paths: paths, tokens: FixtureTokens(), appVersion: "9.9.9", analytics: analytics, onError: { XCTFail($0) })
        try await engine.start()
        XCTAssertThrowsError(try DaemonLock(paths: paths))
        if stopEarly {
            let deadline = ContinuousClock.now.advanced(by: .seconds(3))
            while !FileManager.default.fileExists(atPath: home.appendingPathComponent("running").path), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent("running").path))
            if cancelOne {
                await engine.cancelAgent("fixture-agent")
                XCTAssertThrowsError(try DaemonLock(paths: paths))
            }
            if let control {
                await fixture.setControl(control)
                await engine.forcePoll()
                let closeDeadline = ContinuousClock.now.advanced(by: .seconds(3))
                while await engine.snapshots().first?.mode != .idle, ContinuousClock.now < closeDeadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                let snapshots = await engine.snapshots()
                XCTAssertEqual(snapshots.first?.mode, .idle)
            }
            await engine.stop()
        }
        await fulfillment(of: [finished], timeout: control == nil ? 10 : 0.05)
        await engine.stop()
        await server.stop()
        let close = await fixture.close, uploaded = await fixture.uploaded
        if control != nil { XCTAssertNil(close); XCTAssertTrue(uploaded.isEmpty) }
        else {
            XCTAssertEqual(close?["status"], .string(stopEarly ? "cancelled" : (exitCode == 0 ? "closed" : "crashed")))
            XCTAssertEqual(close?["final_text"], .string("result é猫\nfixture-task"))
            XCTAssertEqual(try PayloadEncryption.decrypt(uploaded, key: fixture.key), Data("result é猫\nfixture-task".utf8))
        }
        let journal = try String(contentsOf: paths.tasks.appendingPathComponent("fixture-task.jsonl"), encoding: .utf8)
        let events = try journal.split(separator: "\n").map { try JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)) }
        XCTAssertEqual(events.map { $0["type"]?.string }, control == nil ? ["task_start", "message", "task_end"] : ["task_start", "message"])
        let log = try String(contentsOf: paths.logs.appendingPathComponent("Test-agent/fixture-task.log"), encoding: .utf8)
        XCTAssertTrue(log.contains("result é猫"))
        XCTAssertFalse(log.contains("\u{1b}"))
        if control == nil, !stopEarly {
            // Go's run log: `# started=`, timestamped running/exit events, outcome and `# ended=`.
            let ts = #"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)"#
            let outcome = exitCode == 0 ? "event=success" : "event=failure status=crashed"
            for pattern in ["(?m)^# started=\(ts)$", "(?m)^\(ts) \\[EVENT\\] event=running via=pipe pid=\\d+$",
                            "(?m)^\(ts) \\[EVENT\\] event=exit code=\(exitCode)$", "\n\n\\[EVENT\\] \(outcome)\n# ended=\(ts)\n$"] {
                XCTAssertNotNil(log.range(of: pattern, options: .regularExpression), "\(pattern)\n\(log)")
            }
        }
        let released = try DaemonLock(paths: paths)
        withExtendedLifetime(released) { }
        // Go's analytics events for the same lifecycle, flushed as one JSON array.
        await analytics.flush()
        let names = await recorder.events.compactMap { $0["event_type"]?.string }
        XCTAssertEqual(Array(names.prefix(3)), ["daemon_start", "task_received", "task_started"])
        if control == nil, !stopEarly { XCTAssertTrue(names.contains(exitCode == 0 ? "task_completed" : "task_failed"), "\(names)") }
        let started = await recorder.events.first { $0["event_type"]?.string == "task_started" }
        XCTAssertEqual(started?["properties"]?["via"]?.string, "pipe")
        XCTAssertEqual(started?["device_id"]?.string, "device-1")
        XCTAssertEqual(started?["app_version"]?.string, "9.9.9")
    }
}

/// Collects every event Analytics posts to Amplitude's batch endpoint.
actor AnalyticsRecorder: HTTPTransport {
    var events: [JSONValue] = []
    func send(_ request: URLRequest) async throws -> HTTPResult {
        if request.url == Analytics.endpoint, let body = request.httpBody, case .array(let batch)? = try? JSONDecoder().decode(JSONValue.self, from: body) {
            events += batch
        }
        return HTTPResult(data: Data(), status: 200)
    }
}

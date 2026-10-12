import XCTest
@testable import TaskSquadCLI
@testable import TaskSquadCore

private struct UserTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "user-token" }
}

private actor CustomerWorker {
    var calls: [String] = []
    var agentHeaders: [String] = []
    var bodies: [String] = []
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        let query = request.components?.percentEncodedQuery.map { "?" + $0 } ?? ""
        calls.append("\(request.method) \(request.path)\(query)")
        agentHeaders.append(request.headers["x-tsq-agent"] ?? "")
        bodies.append(String(decoding: request.body, as: UTF8.self))
        func raw(_ text: String, _ status: Int = 200) -> LocalHTTPResponse { .init(status: status, body: Data(text.utf8)) }
        switch request.path {
        case "/teams": return raw(#"{"teams":[{"id":"t1","name":"A<B>","count":12345678901234567890,"ratio":1.50,"api_token":"x"}]}"#)
        case "/tasks/task-1": return raw(#"{"id":"task-1","team_id":"team-1","status":"running"}"#)
        case "/tasks/task-1/messages": return raw(#"{"messages":[{"body":"hi"}]}"#)
        case "/tasks/other": return raw(#"{"id":"other","team_id":"team-2","status":"running"}"#)
        case "/tasks/done": return raw(#"{"id":"done","team_id":"team-1","status":"failed"}"#)
        case "/redirect": return .init(status: 302, headers: ["Location": "https://example.com/"], body: Data())
        default: return raw("{}", 404)
        }
    }
}

/// Go's cmd/customer behaviour against a worker double (Go itself would read the real Keychain).
final class CustomerCommandTests: PlatformTestCase {
    private func run(_ args: [String]) async throws -> (code: Int32, out: String, err: String, worker: CustomerWorker) {
        let worker = CustomerWorker()
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-cust-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let captured = Captured()
        let context = CLIContext(environment: ["HOME": home.path], stdout: { captured.write($0, error: false) }, stderr: { captured.write($0, error: true) },
                                 tokens: UserTokens(), customerTransport: NoRedirectTransport())
        let code = await TSQCommandLine.run(args + ["--api-url", "http://127.0.0.1:\(port)"], context: context)
        await server.stop()
        return (code, captured.stdout, captured.stderr, worker)
    }

    func testProjectsKeepNumberLiteralsSortKeysEscapeAndRedact() async throws {
        let r = try await run(["projects", "list"])
        XCTAssertEqual(r.code, 0, r.err)
        XCTAssertEqual(r.out, """
        {
          "teams": [
            {
              "api_token": "[redacted]",
              "count": 12345678901234567890,
              "id": "t1",
              "name": "A\\u003cB\\u003e",
              "ratio": 1.50
            }
          ]
        }

        """)
        let compact = try await run(["projects", "list", "--json"])
        XCTAssertEqual(compact.out, #"{"teams":[{"api_token":"[redacted]","count":12345678901234567890,"id":"t1","name":"A\u003cB\u003e","ratio":1.50}]}"# + "\n")
        let headers = await r.worker.agentHeaders
        XCTAssertEqual(headers, [""], "user-scoped: never the daemon agent header")
    }

    func testTaskGetMergesMessagesAndRejectsOtherProjects() async throws {
        let get = try await run(["tasks", "get", "--project", "team-1", "--id", "task-1", "--json"])
        XCTAssertEqual(get.out, #"{"id":"task-1","messages":[{"body":"hi"}],"status":"running","team_id":"team-1"}"# + "\n")
        let calls = await get.worker.calls
        XCTAssertEqual(calls, ["GET /tasks/task-1", "GET /tasks/task-1/messages"])
        let foreign = try await run(["tasks", "close", "--project", "team-1", "--id", "other"])
        XCTAssertEqual(foreign.code, 1); XCTAssertEqual(foreign.err, "record does not belong to --project\n")
        let reply = try await run(["tasks", "reply", "--project", "team-1", "--id", "task-1", "--body", "go on"])
        let replyCalls = await reply.worker.calls, bodies = await reply.worker.bodies
        XCTAssertEqual(replyCalls, ["GET /tasks/task-1", "POST /tasks/task-1/messages"])
        XCTAssertEqual(bodies.last, #"{"body":"go on"}"# + "\n")
    }

    func testWaitTimesOutWithExitThreeAndTerminalStatusFails() async throws {
        let wait = try await run(["tasks", "wait", "--project", "team-1", "--id", "task-1", "--timeout", "1500ms", "--json"])
        XCTAssertEqual(wait.code, 3)
        XCTAssertEqual(wait.err, "context deadline exceeded\n")
        XCTAssertEqual(wait.out, #"{"id":"task-1","status":"running","team_id":"team-1"}"# + "\n")
        let failed = try await run(["tasks", "wait", "--project", "team-1", "--id", "done"])
        XCTAssertEqual(failed.code, 1)
        XCTAssertEqual(failed.err, "task reached failed before waiting_input\n")
    }

    func testErrorsAndRedirectsUseGoWording() async throws {
        let missing = try await run(["tasks", "list", "--project", "nope"])
        XCTAssertEqual(missing.err, "API HTTP 404\n")
        let calls = await missing.worker.calls
        XCTAssertEqual(calls, ["GET /tasks?team_id=nope"])
        let client = CustomerClient(baseURL: "http://127.0.0.1:1", token: "t", transport: NoRedirectTransport(), readFile: { _ in nil })
        do { _ = try await client.request("GET", "/teams", deadline: Date().addingTimeInterval(5)); XCTFail() }
        catch let failure as CustomerCommands.Failure { XCTAssertEqual(failure.message, "API request failed") }
        let worker = CustomerWorker()
        let server = try LocalHTTPServer { await worker.handle($0) }
        let port = try await server.start()
        let redirecting = CustomerClient(baseURL: "http://127.0.0.1:\(port)", token: "t", transport: NoRedirectTransport(), readFile: { _ in nil })
        do { _ = try await redirecting.request("GET", "/redirect", deadline: Date().addingTimeInterval(5)); XCTFail() }
        catch let failure as CustomerCommands.Failure { XCTAssertEqual(failure.message, "API HTTP 302", "redirects are never followed") }
        await server.stop()
        for (bytes, mime) in [([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "image/png"), ([0xFF, 0xD8, 0xFF, 0xE0], "image/jpeg"),
                              (Array("GIF89a".utf8), "image/gif"), (Array("RIFF\0\0\0\0WEBPVP8 ".utf8), "image/webp")] as [([UInt8], String)] {
            XCTAssertEqual(CustomerClient.sniff(Data(bytes)), mime)
        }
        XCTAssertEqual(GoFlagSet.goDuration("1h30m"), 5400); XCTAssertEqual(GoFlagSet.goDuration("1500ms"), 1.5); XCTAssertNil(GoFlagSet.goDuration("1x"))
    }
}

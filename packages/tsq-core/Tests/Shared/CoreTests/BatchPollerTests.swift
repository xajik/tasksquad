import XCTest
@testable import TaskSquadCore

private actor BatchTokens: TokenProvider {
    var calls: [Bool] = []
    func token(forceRotation: Bool) async throws -> String {
        calls.append(forceRotation)
        return forceRotation ? "rotated" : "initial"
    }
}
private actor BatchTransport: HTTPTransport {
    var requests: [URLRequest] = []
    func send(_ request: URLRequest) async throws -> HTTPResult {
        requests.append(request)
        if requests.count == 1 { return .init(data: Data(), status: 401) }
        return .init(data: Data(#"{"agents":[{"agent_id":"one","next_poll_ms":60000}]}"#.utf8), status: 200, headers: ["ETag": "tag"])
    }
}

@MainActor final class BatchPollerTests: PlatformTestCase {
    func testRateLimitBackoffAndServerHint() {
        var timing = BatchTiming(pollInterval: 60)
        XCTAssertEqual(timing.receive(status: 200, etag: "a", agents: [.object(["next_poll_ms": .number(2000)])]), .seconds(2))
        XCTAssertEqual(timing.etag, "a")
        for delay in [30, 60, 120, 240, 300, 300] { XCTAssertEqual(timing.receive(status: 429), .seconds(delay)) }
        XCTAssertEqual(timing.receive(status: 304, etag: "ignored"), .seconds(2))
        XCTAssertEqual(timing.etag, "a")
        XCTAssertEqual(timing.receive(status: 429), .seconds(30))
        XCTAssertEqual(timing.receive(status: 500), .seconds(2))
    }

    func testInitialPoll401RetryAndForcePoll() async throws {
        let transport = BatchTransport(), tokens = BatchTokens()
        let first = expectation(description: "first response")
        let second = expectation(description: "forced response")
        actor Delivery {
            var count = 0
            func next() -> Int { count += 1; return count }
        }
        let delivery = Delivery()
        let poller = BatchPoller(api: WorkerAPI(baseURL: "https://test.invalid", transport: transport), tokens: tokens, pollInterval: 60,
            entries: { [.object(["id": .string("one"), "status": .string("idle")])] },
            receive: { agents in
                XCTAssertEqual(agents.first?["agent_id"]?.string, "one")
                switch await delivery.next() { case 1: first.fulfill(); case 2: second.fulfill(); default: break }
            }, onError: { error in XCTFail(error.localizedDescription) })
        await poller.start()
        await fulfillment(of: [first], timeout: 3)
        await poller.forcePoll()
        await fulfillment(of: [second], timeout: 3)
        await poller.stop()
        let calls = await tokens.calls, requests = await transport.requests
        XCTAssertEqual(calls, [false, true, false])
        XCTAssertEqual(requests.count, 3)
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer rotated")
        XCTAssertEqual(requests[2].value(forHTTPHeaderField: "If-None-Match"), "tag")
    }
}

private actor ScriptedTransport: HTTPTransport {
    var statuses: [Int]
    var requests: [URLRequest] = []
    init(_ statuses: [Int]) { self.statuses = statuses }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        requests.append(request)
        let status = statuses.isEmpty ? 200 : statuses.removeFirst()
        try await Task.sleep(for: .milliseconds(30))
        return .init(data: Data(#"{"agents":[{"agent_id":"one","next_poll_ms":60000}]}"#.utf8), status: status, headers: ["ETag": "e\(requests.count)"])
    }
}
private actor Events { var names: [String] = []; func add(_ n: String) { names.append(n) } }

extension BatchPollerTests {
    /// Go: ForcePoll is non-blocking and coalesces while one is pending; a second
    /// 401 after rotation is reported (task_poll_auth_failed); 429 backs off and is tracked.
    func testForcePollCoalescesAndFailuresAreTracked() async throws {
        let transport = ScriptedTransport([401, 401, 429, 200])
        let events = Events()
        let poller = BatchPoller(api: WorkerAPI(baseURL: "https://test.invalid", transport: transport), tokens: BatchTokens(), pollInterval: 60,
                                 entries: { [] }, receive: { _ in }, onError: { _ in }, track: { name, _ in Task { await events.add(name) } })
        await poller.start()
        try await Task.sleep(for: .milliseconds(200))
        for _ in 0..<10 { await poller.forcePoll() }
        try await Task.sleep(for: .milliseconds(400))
        await poller.stop()
        let requests = await transport.requests.count
        XCTAssertLessThanOrEqual(requests, 5, "ten force-polls coalesce into a pending one")
        XCTAssertGreaterThanOrEqual(requests, 3)
        let names = await events.names
        XCTAssertTrue(names.contains("task_poll_auth_failed"), "\(names)")
        XCTAssertTrue(names.contains("task_poll_rate_limited"), "\(names)")
    }

    func testStopThenStartPollsAgainWithFreshETag() async throws {
        let transport = ScriptedTransport([])
        let poller = BatchPoller(api: WorkerAPI(baseURL: "https://test.invalid", transport: transport), tokens: BatchTokens(), pollInterval: 60,
                                 entries: { [] }, receive: { _ in }, onError: { _ in })
        await poller.start()
        try await Task.sleep(for: .milliseconds(150))
        await poller.stop()
        await poller.start()
        try await Task.sleep(for: .milliseconds(150))
        await poller.stop()
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2, "each start polls immediately")
        XCTAssertNil(requests.last?.value(forHTTPHeaderField: "If-None-Match"), "a restart drops the previous ETag")
    }
}

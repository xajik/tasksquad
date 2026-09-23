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

@MainActor final class BatchPollerTests: XCTestCase {
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

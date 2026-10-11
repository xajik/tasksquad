import XCTest
@testable import TaskSquadPortal

private actor WorkspaceTransport: HTTPTransport {
    var closeFails = false
    var mutationCount = 0
    func failClose() { closeFails = true }
    func count() -> Int { mutationCount }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        let path = request.url!.path
        var body = "{}"
        if request.httpMethod == "POST" {
            mutationCount += 1
            try await Task.sleep(for: .milliseconds(30))
            if closeFails { return HTTPResult(data: Data("{\"error\":\"close rejected\"}".utf8), status: 503) }
            body = "{\"id\":\"new\",\"status\":\"pending\"}"
        } else if path == "/me" { body = "{\"id\":\"u\",\"plan\":\"pro\"}" }
        else if path == "/teams" { body = "{\"teams\":[{\"id\":\"slow\",\"name\":\"Slow\",\"role\":\"owner\"},{\"id\":\"fast\",\"name\":\"Fast\",\"role\":\"owner\"}]}" }
        else if path.hasSuffix("/agents") { body = "{\"agents\":[]}" }
        else if path == "/tasks" {
            let team = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "team_id" }!.value!
            if team == "slow" { try await Task.sleep(for: .milliseconds(80)) }
            body = "{\"tasks\":[{\"id\":\"\(team)\",\"subject\":\"\(team)\",\"status\":\"done\",\"scheduled_at\":1}]}"
        }
        return HTTPResult(data: Data(body.utf8), status: 200)
    }
}

final class WorkspaceStoreTests: XCTestCase {
    @MainActor func testProjectChangeRejectsLateResponseAndClearsSelectionData() async throws {
        let transport = WorkspaceTransport()
        let store = WorkspaceStore(api: CustomerAPI(baseURL: URL(string:"https://example.test")!, transport: transport) { _ in "token" })
        store.projectID = "slow"
        let slow = Task { await store.refresh() }
        try await Task.sleep(for: .milliseconds(10))
        store.projectID = "fast"
        XCTAssertTrue(store.records.isEmpty)
        await store.refresh(); await slow.value
        XCTAssertEqual(store.records.map(\.id), ["fast"])
        store.origin = "scheduled"
        XCTAssertTrue(store.visibleRecords.isEmpty, "Historical schedule metadata does not imply scheduled work")
    }
    @MainActor func testFailedCloseIsVisibleAndConcurrentCreateIsSuppressed() async throws {
        let transport = WorkspaceTransport()
        let store = WorkspaceStore(api: CustomerAPI(baseURL: URL(string:"https://example.test")!, transport: transport) { _ in "token" })
        await transport.failClose()
        let closed = await store.mutate(["portals","id","close"])
        XCTAssertNil(closed)
        XCTAssertEqual(store.error, "close rejected")
        let first = Task { await store.mutate(["portals"]) }
        try await Task.sleep(for: .milliseconds(5))
        let duplicate = await store.mutate(["portals"])
        XCTAssertNil(duplicate)
        _ = await first.value
        let count = await transport.count()
        XCTAssertEqual(count, 2)
    }
    @MainActor func testMutationResultSurvivesSectionAndFilterChanges() async throws {
        let transport = WorkspaceTransport()
        let store = WorkspaceStore(api: CustomerAPI(baseURL: URL(string:"https://example.test")!, transport: transport) { _ in "token" })
        store.projectID = "fast"
        let reply = Task { await store.mutate(["tasks", "t", "messages"], body: ["body": .string("hi")]) }
        try await Task.sleep(for: .milliseconds(5))
        store.section = .notes; store.archived = true
        let result = await reply.value
        XCTAssertNotNil(result, "The server accepted the reply; dropping it invites a duplicate resubmit")
        XCTAssertFalse(store.busy)
    }
    @MainActor func testUnrelatedMutationsRunConcurrentlyButProjectChangeDropsResult() async throws {
        let transport = WorkspaceTransport()
        let store = WorkspaceStore(api: CustomerAPI(baseURL: URL(string:"https://example.test")!, transport: transport) { _ in "token" })
        store.projectID = "fast"
        let reply = Task { await store.mutate(["tasks", "t", "messages"]) }
        try await Task.sleep(for: .milliseconds(5))
        XCTAssertTrue(store.isRunning(["tasks", "t", "messages"]))
        let grade = await store.mutate(["tasks", "t", "grade"])
        XCTAssertNotNil(grade)
        store.projectID = "slow"
        let late = await reply.value
        XCTAssertNil(late, "A result for the previous project must not reach the new one")
        XCTAssertTrue(store.inFlight.isEmpty)
    }
}

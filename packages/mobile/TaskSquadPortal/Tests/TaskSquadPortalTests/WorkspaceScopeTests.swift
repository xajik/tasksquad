import XCTest
@testable import TaskSquadPortal

/// 150 notes served 100 per page; task detail for "slow" lags behind "fast";
/// `/me` answers with whichever account is currently signed in.
private actor ScopeTransport: HTTPTransport {
    var account = "u1"
    func signIn(_ id: String) { account = id }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        let url = request.url!, path = url.path
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        let json: String
        switch path {
        case "/me": json = #"{"id":"\#(account)","plan":"free"}"#
        case "/teams": json = #"{"teams":[{"id":"\#(account)-team","name":"T","role":"owner"}]}"#
        case _ where path.hasSuffix("/agents"): json = #"{"agents":[]}"#
        case _ where path.hasSuffix("/notes"):
            let offset = Int(query["offset"] ?? "0") ?? 0, end = min(offset + 100, 150)
            let notes = (offset..<end).map { #"{"id":"n\#($0)","title":"Note \#($0)"}"# }.joined(separator: ",")
            json = #"{"notes":[\#(notes)],"has_more":\#(end < 150)}"#
        case "/tasks/slow", "/tasks/fast":
            let id = String(path.dropFirst(7))
            if id == "slow" { try await Task.sleep(for: .milliseconds(80)) }
            json = #"{"id":"\#(id)","subject":"\#(id)","status":"running"}"#
        case _ where path.hasSuffix("/messages"): json = #"{"messages":[]}"#
        default: json = "{}"
        }
        return HTTPResult(data: Data(json.utf8), status: 200)
    }
}

final class WorkspaceScopeTests: XCTestCase {
    @MainActor private func store(_ transport: ScopeTransport) -> WorkspaceStore {
        WorkspaceStore(api: CustomerAPI(baseURL: URL(string: "https://example.test")!, transport: transport) { _ in "token" })
    }

    @MainActor func testLoadedNotePagesSurviveRefresh() async {
        let store = store(ScopeTransport())
        store.projectID = "p"; store.section = .notes
        await store.refresh()
        XCTAssertEqual(store.records.count, 100); XCTAssertTrue(store.hasMore)
        await store.refresh(loadMore: true)
        XCTAssertEqual(store.records.count, 150); XCTAssertFalse(store.hasMore)
        await store.refresh()
        XCTAssertEqual(store.records.count, 150, "A poll must not collapse pages the user already loaded")
        XCTAssertEqual(Set(store.records.map(\.id)).count, 150)
    }

    @MainActor func testLateDetailResponseDoesNotReplaceNewerSelection() async throws {
        let store = store(ScopeTransport()), detail = RecordDetailStore()
        store.projectID = "p"
        let slow = Task { await detail.refresh(workspace: store, id: "slow") }
        try await Task.sleep(for: .milliseconds(10))
        await detail.refresh(workspace: store, id: "fast")
        await slow.value
        XCTAssertEqual(detail.detail?.id, "fast")
    }

    @MainActor func testAccountSwitchResetsProjectAndScopedState() async {
        let transport = ScopeTransport(), store = store(transport)
        await store.connect()
        XCTAssertEqual(store.projectID, "u1-team")
        store.search = "keep?"
        await transport.signIn("u2")
        await store.connect()
        XCTAssertEqual(store.profile?.id, "u2")
        XCTAssertEqual(store.projectID, "u2-team", "The previous account's project must not carry over")
        XCTAssertEqual(store.search, "")
        XCTAssertEqual(store.draftScope("reply.t").account, "u2")
    }
}

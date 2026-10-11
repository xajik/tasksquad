import XCTest
@testable import TaskSquadPortal

final class WorkspaceDraftStoreTests: XCTestCase {
    @MainActor func testDraftsAreIsolatedByOriginAccountProjectAndOperation() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "WorkspaceDraftStoreTests"))
        defaults.removePersistentDomain(forName: "WorkspaceDraftStoreTests")
        let store = WorkspaceDraftStore(defaults: defaults, prefix: "test.")
        let base = WorkspaceDraftScope(origin: "https://a", account: "u1", project: "p", operation: "reply.t")
        store.save(["body": .string("hello")], scope: base)
        for other in [WorkspaceDraftScope(origin: "https://b", account: "u1", project: "p", operation: "reply.t"),
                      WorkspaceDraftScope(origin: "https://a", account: "u2", project: "p", operation: "reply.t"),
                      WorkspaceDraftScope(origin: "https://a", account: "u1", project: "q", operation: "reply.t"),
                      WorkspaceDraftScope(origin: "https://a", account: "u1", project: "p", operation: "reply.x"),
                      // Delimiters inside IDs must not let two scopes collide.
                      WorkspaceDraftScope(origin: "https://a", account: "u1.p", project: "", operation: "reply.t")] {
            XCTAssertNil(store.load(other))
        }
        XCTAssertEqual(store.load(base)?["body"], .string("hello"))
        store.clear()
        XCTAssertNil(store.load(base))
    }
}

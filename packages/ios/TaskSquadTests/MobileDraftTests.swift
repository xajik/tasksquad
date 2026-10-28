import XCTest
import TaskSquadPortal
@testable import TaskSquad

final class MobileDraftTests: XCTestCase {
    func testAttachmentRoundTripIsolationRemovalAndCleanup() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = MobileAttachmentDraftStore(root: root)
        defer { try? store.clear() }
        let image = CustomerUpload(name: "猫 image.png", mimeType: "image/png", data: Data([1, 2, 3]))
        try store.save([image], key: "account/project/reply")
        let restored = try store.load("account/project/reply")
        XCTAssertEqual(restored.first?.name, image.name)
        XCTAssertEqual(restored.first?.data, image.data)
        XCTAssertTrue(try store.load("other/project/reply").isEmpty)
        try store.save([image], key: "other/project/reply")
        try store.save([], key: "account/project/reply")
        XCTAssertTrue(try store.load("account/project/reply").isEmpty)
        XCTAssertEqual(try store.load("other/project/reply").count, 1)
        try store.clear()
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }
    func testRejectedUpdatePreservesExistingDraft() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = MobileAttachmentDraftStore(root: root)
        defer { try? store.clear() }
        let image = CustomerUpload(name: "original.png", mimeType: "image/png", data: Data([1]))
        try store.save([image], key: "draft")
        XCTAssertThrowsError(try store.save(Array(repeating: image, count: 6), key: "draft"))
        XCTAssertEqual(try store.load("draft").first?.data, image.data)
    }
}

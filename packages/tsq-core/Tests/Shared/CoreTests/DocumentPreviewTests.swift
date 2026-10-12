import XCTest
@testable import TaskSquadCore

final class DocumentPreviewTests: PlatformTestCase {
    func testJSONKeepsHugeNumbersDuplicateKeysAndEscapedUnicode() throws {
        let source = #"{"id":90071992547409931234,"id":-1.2300e+200,"name":"e\u0301 猫","nested":[true,null,{"x":"line\nnext"}]}"#
        let root = try XCTUnwrap(JSONPreviewNode.parse(source).first)
        XCTAssertEqual(root.raw, source)
        XCTAssertEqual(root.children.map(\.label), ["id", "id", "name", "nested"])
        XCTAssertEqual(root.children[0].value, "90071992547409931234")
        XCTAssertEqual(root.children[1].value, "-1.2300e+200")
        XCTAssertEqual(root.children[2].value, "e\u{301} 猫")
        XCTAssertEqual(Set(root.children.map(\.id)).count, 4)
        XCTAssertEqual(root.children[3].children[2].children[0].value, "line\nnext")
    }
    func testMalformedJSONDoesNotBecomeMisleadingPreview() {
        for value in ["{", "[1,]", "{\"a\":1,}", "[01]", "NaN", "true false", "\"bad\\q\"", "{\"a\" 1}"] {
            XCTAssertThrowsError(try JSONPreviewNode.parse(value), value)
        }
    }
    func testJSONLIsolatesBadRecords() throws {
        let nodes = try JSONPreviewNode.parse("{\"a\":1}\ninvalid\n\n{\"b\":2}\n", lines: true)
        XCTAssertEqual(nodes.count, 3)
        XCTAssertEqual(nodes.map(\.kind), [.object, .invalid, .object])
        XCTAssertEqual(nodes.last?.label, "Record 4")
    }
    func testJSONDepthIsBounded() { XCTAssertThrowsError(try JSONPreviewNode.parse(String(repeating: "[", count: 200) + "0" + String(repeating: "]", count: 200))) }
    func testTruncatedJournalStartsOnRecordBoundaryAndNoticeIsNotContent() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".jsonl")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data((String(repeating: "{\"long\":true}\n", count: 20) + "{\"last\":true}\n").utf8).write(to: url)
        let document = try PreviewDocument.load(url, limit: 50)
        XCTAssertNotNil(document.notice)
        XCTAssertFalse(document.text.contains("Preview limited"))
        let nodes = try JSONPreviewNode.parse(document.text, lines: true)
        XCTAssertTrue(nodes.allSatisfy { $0.kind == .object })
        XCTAssertEqual(nodes.last?.children.first?.label, "last")
    }
}

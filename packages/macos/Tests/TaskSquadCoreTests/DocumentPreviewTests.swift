import XCTest
@testable import TaskSquadCore

final class DocumentPreviewTests: XCTestCase {
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
    func testMarkdownKeepsFencedCodeAndStructuredContent() {
        let source = "# Heading\n\n**Body** and `code`.\n\n```swift\nlet n = 1\n# not a heading\n```\n\n> A quote\n> next line\n\n- [x] done\n  - nested\n\n| Key | Value |\n| --- | --- |\n| a | 1 |\n\n---"
        let blocks = MarkdownBlock.parse(source)
        XCTAssertEqual(blocks.map(\.kind), [.heading(1), .paragraph, .code("swift"), .quote, .task(true, 0), .list("•", 1), .table, .rule])
        XCTAssertEqual(blocks[2].text, "let n = 1\n# not a heading")
        XCTAssertEqual(blocks[6].rows, [["Key", "Value"], ["a", "1"]])
    }
    func testMinimalSingleDashTableSeparatorIsRecognized() {
        // GFM only requires >=1 hyphen per delimiter cell, e.g. "|-|-|".
        let blocks = MarkdownBlock.parse("|Name|Age|\n|-|-|\n|Alice|30|")
        XCTAssertEqual(blocks.map(\.kind), [.table])
        XCTAssertEqual(blocks[0].rows, [["Name", "Age"], ["Alice", "30"]])
    }
    func testLongerFenceAndSetextHeading() {
        let blocks = MarkdownBlock.parse("Title\n=====\n\n````md\n```swift\nvalue\n```\n````")
        XCTAssertEqual(blocks.map(\.kind), [.heading(1), .code("md")])
        XCTAssertEqual(blocks.last?.text, "```swift\nvalue\n```")
    }
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
    func testANSIScreenStylesAndUnsafeSequences() {
        let source = "\u{1b}[1;31mRed\u{1b}[0m plain\n\u{1b}[38;2;1;2;3mRGB\u{1b}[48;5;42mBG\u{1b}]52;c;Zm9v\u{7}safe"
        let lines = TerminalANSI.lines(source)
        XCTAssertEqual(lines[0][0].style.foreground, .indexed(1)); XCTAssertTrue(lines[0][0].style.bold)
        XCTAssertFalse(lines[0][1].style.bold)
        XCTAssertEqual(lines[1][0].style.foreground, .rgb(1, 2, 3))
        XCTAssertEqual(lines[1][1].style.background, .indexed(42))
        XCTAssertEqual(TerminalANSI.plain(source), "Red plain\nRGBBGsafe")
    }
}

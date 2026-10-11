import XCTest
@testable import TaskSquadPortal

/// One parser renders task messages, notes and local documents on iOS and macOS.
final class MarkdownBlockTests: XCTestCase {
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
}

import XCTest
@testable import TaskSquadMacPlatform

/// The app's ANSI renderer (macOS only; not part of tsq-core).
final class TerminalANSITests: PlatformTestCase {
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

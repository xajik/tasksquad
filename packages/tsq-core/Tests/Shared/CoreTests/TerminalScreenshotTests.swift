import XCTest
@testable import TaskSquadCore

/// Ported from packages/daemon/screenshot/{sgr,render}_test.go, plus a real tmux capture.
/// Rendering goes through the installed platform's rasterizer.
final class TerminalScreenshotTests: PlatformTestCase {
    typealias S = TerminalScreenshot

    func testPlainTextPadsWithDefaults() {
        let grid = S.parseGrid("hi", columns: 4)
        XCTAssertEqual(grid.count, 1); XCTAssertEqual(grid[0].count, 4)
        XCTAssertEqual(grid[0].map { Character($0.scalar) }, ["h", "i", " ", " "])
        XCTAssertTrue(grid[0].allSatisfy { $0.fg == S.defaultFG && $0.bg == S.defaultBG })
    }

    func testAttributesAndColors() {
        var row = S.parseGrid("\u{1b}[31mred\u{1b}[0mok", columns: 8)[0]
        XCTAssertTrue(row[0..<3].allSatisfy { $0.fg == S.ansi16[1] })
        XCTAssertTrue(row[3..<5].allSatisfy { $0.fg == S.defaultFG })
        row = S.parseGrid("\u{1b}[1mB\u{1b}[22mN", columns: 2)[0]
        XCTAssertTrue(row[0].bold); XCTAssertFalse(row[1].bold)
        XCTAssertTrue(S.parseGrid("\u{1b}[7mR", columns: 1)[0][0].reverse)
        row = S.parseGrid("\u{1b}[4mU\u{1b}[24mN", columns: 2)[0]
        XCTAssertTrue(row[0].underline); XCTAssertFalse(row[1].underline)
        XCTAssertEqual(S.parseGrid("\u{1b}[38;5;208mX", columns: 1)[0][0].fg, S.color256(208))
        XCTAssertEqual(S.parseGrid("\u{1b}[38;2;10;20;30mX", columns: 1)[0][0].fg, S.RGBA(10, 20, 30))
        XCTAssertEqual(S.parseGrid("\u{1b}[44mX", columns: 1)[0][0].bg, S.ansi16[4])
    }

    func testStateCarriesAcrossLinesAndShortLinesUseDefaultBackground() {
        let grid = S.parseGrid("\u{1b}[1mA\nB", columns: 2)
        XCTAssertEqual(grid.count, 2); XCTAssertTrue(grid[0][0].bold); XCTAssertTrue(grid[1][0].bold)
        let padded = S.parseGrid("\u{1b}[44mX", columns: 4)[0]
        XCTAssertTrue(padded[1...].allSatisfy { $0.bg == S.defaultBG })
    }

    func testPalette() {
        XCTAssertEqual(S.color256(0), S.ansi16[0]); XCTAssertEqual(S.color256(15), S.ansi16[15])
        XCTAssertEqual(S.color256(16), S.RGBA(0, 0, 0)); XCTAssertEqual(S.color256(231), S.RGBA(255, 255, 255))
        XCTAssertEqual(S.color256(232), S.RGBA(8, 8, 8)); XCTAssertEqual(S.color256(255), S.RGBA(238, 238, 238))
    }

    /// Width and height from the PNG signature + IHDR chunk.
    private func size(_ png: Data) throws -> (Int, Int) {
        let bytes = [UInt8](png)
        XCTAssertEqual(Array(bytes.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], "PNG signature")
        guard bytes.count >= 24, Array(bytes[12..<16]) == Array("IHDR".utf8) else { throw XCTSkip("not a PNG") }
        func be(_ at: Int) -> Int { bytes[at..<at + 4].reduce(0) { $0 << 8 | Int($1) } }
        return (be(16), be(20))
    }

    private func render(_ grid: [[S.Cell]]) throws -> Data { try Platform.current.renderScreenshot(grid) }

    func testRenderDimensionsMatchGoCells() throws {
        let (w, h) = try size(try render(S.parseGrid("hi\nyo", columns: 2)))
        XCTAssertEqual(w, 2 * 10); XCTAssertEqual(h, 2 * 22)
        XCTAssertEqual(try size(try render([])).0, 10)
    }

    func testCapturesARealTmuxPane() async throws {
        guard let executable = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux")
        else { throw XCTSkip("tmux is required") }
        let tmux = TmuxConnection(executable: executable, socketPath: "/tmp/tsq-shot-" + UUID().uuidString.prefix(8) + ".sock")
        _ = try await tmux.run(["-f", "/dev/null", "new-session", "-d", "-s", "shot", "-x", "40", "-y", "6", "/bin/sh", "-c",
                                "printf '\\033[1;32mREADY\\033[0m café \\033[44m blue \\033[0m\\n\\033[4munder\\033[0m'; sleep 30"])
        try await Task.sleep(for: .milliseconds(300))
        let grid = try await S.grid(session: "shot", tmux: tmux)
        XCTAssertEqual(grid.first?.count, 40)
        XCTAssertTrue(grid[0][0].bold && grid[0][0].fg == S.ansi16[2])
        let png: Data
        do { png = try render(grid) } catch { _ = try? await tmux.run(["kill-server"]); throw error }
        _ = try? await tmux.run(["kill-server"])
        let (w, h) = try size(png)
        // capture-pane ends with a newline, so Go's parser adds an empty seventh row too.
        XCTAssertEqual(w, 40 * 10); XCTAssertEqual(h, 7 * 22)
        if let out = ProcessInfo.processInfo.environment["TSQ_SCREENSHOT_OUT"] { try png.write(to: URL(fileURLWithPath: out)) }
        do { _ = try await S.capture(session: "missing", tmux: tmux); XCTFail("expected an error") } catch {}
    }
}

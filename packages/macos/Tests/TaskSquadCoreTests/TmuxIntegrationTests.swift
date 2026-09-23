import XCTest
@testable import TaskSquadCore

@MainActor final class TmuxIntegrationTests: XCTestCase {
    private func connection() throws -> TmuxConnection {
        guard let executable = ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux") ?? ExecutableLocator.find("/usr/local/bin/tmux") else { throw XCTSkip("tmux is required for terminal integration tests") }
        return TmuxConnection(executable: executable, socketPath: "/tmp/tsq-test-" + UUID().uuidString + ".sock")
    }
    func testAttachColorUnicodeInputResizeDetachAndClosePreserveOtherSessions() async throws {
        let connection = try connection()
        do {
            _ = try await connection.run(["-f", "/dev/null", "new-session", "-d", "-s", "agent-test", "-x", "100", "-y", "30", "/bin/sh", "-c", "printf '\\033[31mREADY 猫\\033[0m\\n'; while IFS= read -r line; do printf 'REPLY:%s\\n' \"$line\"; done"])
            _ = try await connection.run(["new-session", "-d", "-s", "unrelated", "/bin/sleep", "120"])
            let panes = try await connection.panes()
            let pane = try XCTUnwrap(panes.first { $0.sessionName == "agent-test" })
            let client = try TmuxControlClient(connection: connection, sessionID: pane.sessionID)
            defer { client.disconnect() }
            var screen = try await TmuxTerminal.screen(client: client, paneID: pane.paneID)
            XCTAssertTrue(TerminalANSI.plain(screen.text).contains("READY 猫"))
            XCTAssertTrue(TerminalANSI.lines(screen.text).flatMap { $0 }.contains { $0.style.foreground == .indexed(1) })
            XCTAssertEqual(screen.columns, 100)
            // Literal metacharacters and Unicode are input bytes, never tmux commands.
            try await TmuxTerminal.send(Data("e\u{301} 猫 ; $(printf BAD)\r".utf8), client: client, paneID: pane.paneID)
            for _ in 0..<30 {
                screen = try await TmuxTerminal.screen(client: client, paneID: pane.paneID)
                if screen.text.contains("REPLY:") { break }; try await Task.sleep(for: .milliseconds(30))
            }
            XCTAssertTrue(TerminalANSI.plain(screen.text).contains("REPLY:e\u{301} 猫 ; $(printf BAD)"))
            _ = try await client.command("refresh-client -f '!ignore-size'")
            _ = try await client.command("refresh-client -C 110,35")
            screen = try await TmuxTerminal.screen(client: client, paneID: pane.paneID)
            XCTAssertEqual(screen.columns, 110)
            XCTAssertTrue((33...35).contains(screen.rows))
            client.disconnect()
            try await Task.sleep(for: .milliseconds(100))
            let afterDetach = try await connection.panes()
            XCTAssertTrue(afterDetach.contains { $0.id == pane.id })
            try await connection.closeSession(pane.sessionID)
            let afterClose = try await connection.panes()
            XCTAssertFalse(afterClose.contains { $0.id == pane.id })
            XCTAssertTrue(afterClose.contains { $0.sessionName == "unrelated" })
        } catch { _ = try? await connection.run(["kill-server"]); throw error }
        _ = try? await connection.run(["kill-server"])
    }
    func testControlConnectionDoesNotReplaceDaemonPipeAndFramesPercentLines() async throws {
        let connection = try connection()
        let log = "/tmp/tsq-pipe-" + UUID().uuidString
        defer { try? FileManager.default.removeItem(atPath: log) }
        do {
            _ = try await connection.run(["-f", "/dev/null", "new-session", "-d", "-s", "agent", "/bin/sh", "-c", "while IFS= read -r line; do printf '%s\\n' \"$line\"; done"])
            let allPanes = try await connection.panes()
            let pane = try XCTUnwrap(allPanes.first)
            _ = try await connection.run(["pipe-pane", "-t", pane.paneID, "cat > " + log])
            let client = try TmuxControlClient(connection: connection, sessionID: pane.sessionID)
            defer { client.disconnect() }
            try await TmuxTerminal.send(Data("%end 123 456 1\rPIPE_STILL_LIVE\r".utf8), client: client, paneID: pane.paneID)
            for _ in 0..<30 {
                if (try? String(contentsOfFile: log, encoding: .utf8))?.contains("PIPE_STILL_LIVE") == true { break }
                try await Task.sleep(for: .milliseconds(30))
            }
            let screen = try await TmuxTerminal.screen(client: client, paneID: pane.paneID)
            XCTAssertTrue(screen.text.contains("%end 123 456 1"))
            XCTAssertTrue(try String(contentsOfFile: log, encoding: .utf8).contains("PIPE_STILL_LIVE"))
            do { _ = try await client.command("capture-pane -p -t %999999"); XCTFail("Expected tmux error") } catch { }
            let reply = try await client.command("display-message -p still-connected")
            XCTAssertEqual(reply, "still-connected")
        } catch { _ = try? await connection.run(["kill-server"]); throw error }
        _ = try? await connection.run(["kill-server"])
    }
    func testFullScreenTUIRepaintsAfterKeyboardMouseAndResize() async throws {
        let connection = try connection()
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-tui-" + UUID().uuidString + ".py")
        try Data(#"""
import os, sys, tty, signal
choice = 1
tty.setraw(0)
def draw(*_):
    width, height = os.get_terminal_size(0)
    sys.stdout.write('\033[?1049h\033[?1000h\033[?1006h\033[?25l\033[H\033[2J')
    sys.stdout.write('\033[1;36mAgent menu 猫\033[0m\r\nChoice:%d Size:%dx%d\r\n1. Inspect\r\n2. Continue\r\n' % (choice, width, height))
    sys.stdout.flush()
signal.signal(signal.SIGWINCH, draw)
draw()
pending = b''
while True:
    pending += os.read(0, 1024)
    if b'\x1b[B' in pending:
        choice = 2; pending = b''; draw()
    elif b'\x1b[<0;1;3M' in pending:
        choice = 1; pending = b''; draw()
"""#.utf8).write(to: script)
        defer { try? FileManager.default.removeItem(at: script) }
        do {
            _ = try await connection.run(["-f", "/dev/null", "new-session", "-d", "-s", "tui", "-x", "90", "-y", "28", "/usr/bin/python3", script.path])
            let panes = try await connection.panes(), pane = try XCTUnwrap(panes.first)
            let client = try TmuxControlClient(connection: connection, sessionID: pane.sessionID)
            defer { client.disconnect() }
            func screenContaining(_ text: String) async throws -> TerminalScreen {
                var screen = try await TmuxTerminal.screen(client: client, paneID: pane.paneID)
                for _ in 0..<60 {
                    if screen.text.contains(text) { return screen }
                    try await Task.sleep(for: .milliseconds(30))
                    screen = try await TmuxTerminal.screen(client: client, paneID: pane.paneID)
                }
                XCTFail("TUI did not render \(text)"); return screen
            }
            var screen = try await screenContaining("Choice:1")
            XCTAssertTrue(screen.mouse); XCTAssertTrue(screen.mouseSGR); XCTAssertFalse(screen.cursorVisible)
            try await TmuxTerminal.send(Data("\u{1b}[B".utf8), client: client, paneID: pane.paneID)
            screen = try await screenContaining("Choice:2")
            XCTAssertTrue(TerminalANSI.plain(screen.text).contains("Agent menu 猫"))
            try await TmuxTerminal.send(Data("\u{1b}[<0;1;3M".utf8), client: client, paneID: pane.paneID)
            _ = try await screenContaining("Choice:1")
            _ = try await client.command("refresh-client -f '!ignore-size'")
            _ = try await client.command("refresh-client -C 120,40")
            screen = try await screenContaining("Size:120x")
            XCTAssertEqual(screen.columns, 120)
        } catch { _ = try? await connection.run(["kill-server"]); throw error }
        _ = try? await connection.run(["kill-server"])
    }

    func testRejectsCommandInjectionInTargetIDs() async throws {
        let connection = try connection()
        XCTAssertThrowsError(try TmuxControlClient(connection: connection, sessionID: "$1; kill-server"))
        do { try await connection.closeSession("$1\nkill-server"); XCTFail("Expected validation") } catch { }
    }
}

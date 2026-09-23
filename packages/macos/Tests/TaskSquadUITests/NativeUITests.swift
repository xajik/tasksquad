import AppKit
import SwiftUI
import XCTest
@testable import TaskSquad
@testable import TaskSquadCore

@MainActor final class NativeUITests: XCTestCase {
    func testTerminalKeyboardAndInputMethodsProduceExactBytes() throws {
        _ = NSApplication.shared
        let view = TerminalCanvas(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        view.screen = TerminalScreen(text: "", metadata: "100,30,0,0,1,0,1,0,0,0,0")
        var bytes = Data(); view.input = { bytes.append($0) }
        func key(_ code: UInt16, _ chars: String, flags: NSEvent.ModifierFlags = []) throws {
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: 0, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code))
            view.keyDown(with: event)
        }
        try key(126, ""); try key(123, "", flags: [.control]); try key(8, "c", flags: [.control])
        try key(36, "\r"); try key(48, "\t", flags: [.shift]); try key(51, "")
        view.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(view.hasMarkedText())
        view.insertText("日本語 e\u{301}", replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertFalse(view.hasMarkedText())
        XCTAssertEqual(bytes, Data("\u{1b}OA\u{1b}[1;5D\u{3}\r\u{1b}[Z\u{7f}日本語 e\u{301}".utf8))
        view.enabled = false; view.insertText("ignored", replacementRange: NSRange(location: 0, length: 0))
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains("ignored"))
    }

    func testWorkspaceAttachesLiveUpdatesDetachesReattachesAndCloses() async throws {
        let tmux = try XCTUnwrap(ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux"))
        let connection = TmuxConnection(executable: tmux, socketPath: "/tmp/tsq-ui-" + UUID().uuidString + ".sock")
        // The UI normally gets Finder PATH setup from main.swift.
        let oldPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        setenv("PATH", URL(fileURLWithPath: tmux).deletingLastPathComponent().path + ":" + oldPath, 1)
        defer { setenv("PATH", oldPath, 1) }
        let model = TerminalWorkspaceModel(); model.socketPath = connection.socketPath!
        do {
            _ = try await connection.run(["-f", "/dev/null", "new-session", "-d", "-s", "tsq-test-agent", "/bin/sh", "-c", "printf 'READY\\n'; while IFS= read -r line; do printf 'REPLY:%s\\n' \"$line\"; done"])
            await model.refresh()
            let pane = try XCTUnwrap(model.panes.first)
            model.attach(pane)
            try await until { model.screen?.text.contains("READY") == true }
            XCTAssertTrue(model.attached)
            model.send(Data("from native app\r".utf8))
            try await until { model.screen?.text.contains("REPLY:from native app") == true }
            model.history = true; model.send(Data("must not send\r".utf8))
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertFalse(model.screen?.text.contains("must not send") ?? false)
            model.detach(); XCTAssertFalse(model.attached)
            let detached = try await connection.panes(); XCTAssertEqual(detached.count, 1)
            model.attach(pane)
            try await until { model.screen?.text.contains("REPLY:from native app") == true }
            await model.closeSelected()
            XCTAssertNil(model.selectedID); XCTAssertFalse(model.attached)
            let closed = try await connection.panes(); XCTAssertTrue(closed.isEmpty)
        } catch { model.detach(); _ = try? await connection.run(["kill-server"]); throw error }
        model.detach(); _ = try? await connection.run(["kill-server"])
    }

    func testRapidSessionSwitchingAndLargeOutputKeepCorrectPaneAndDetachClients() async throws {
        let tmux = try XCTUnwrap(ExecutableLocator.find("tmux") ?? ExecutableLocator.find("/opt/homebrew/bin/tmux"))
        let connection = TmuxConnection(executable: tmux, socketPath: "/tmp/tsq-stress-" + UUID().uuidString + ".sock")
        let oldPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        setenv("PATH", URL(fileURLWithPath: tmux).deletingLastPathComponent().path + ":" + oldPath, 1)
        defer { setenv("PATH", oldPath, 1) }
        let model = TerminalWorkspaceModel(); model.socketPath = connection.socketPath!
        do {
            _ = try await connection.run(["-f", "/dev/null", "new-session", "-d", "-s", "flood", "/bin/sh", "-c", "i=0; while [ $i -lt 12000 ]; do printf 'line %s with streaming output\\n' \"$i\"; i=$((i+1)); done; printf 'FLOOD_DONE\\n'; exec /bin/cat"])
            _ = try await connection.run(["new-session", "-d", "-s", "quiet", "/bin/sh", "-c", "printf 'QUIET_READY\\n'; exec /bin/cat"])
            await model.refresh()
            let flood = try XCTUnwrap(model.panes.first { $0.sessionName == "flood" })
            let quiet = try XCTUnwrap(model.panes.first { $0.sessionName == "quiet" })
            for index in 0..<12 { model.attach(index.isMultiple(of: 2) ? flood : quiet); try await Task.sleep(for: .milliseconds(5)) }
            model.attach(flood)
            try await until { model.screen?.text.contains("FLOOD_DONE") == true }
            XCTAssertLessThan(model.screen?.text.utf8.count ?? .max, 100_000)
            model.attach(quiet)
            try await until { model.screen?.text.contains("QUIET_READY") == true }
            model.send(Data("RIGHT_PANE\r".utf8))
            try await until { model.screen?.text.contains("RIGHT_PANE") == true }
            let other = try await connection.run(["capture-pane", "-p", "-t", flood.paneID])
            XCTAssertFalse(other.contains("RIGHT_PANE"))
            model.detach()
            var clients = ""
            for _ in 0..<50 {
                clients = try await connection.run(["list-clients", "-F", "#{client_control_mode}"])
                if clients.isEmpty { break }; try await Task.sleep(for: .milliseconds(20))
            }
            XCTAssertTrue(clients.isEmpty, "Detached control clients should not leak")
            let survivors = try await connection.panes(); XCTAssertEqual(survivors.count, 2)
        } catch { model.detach(); _ = try? await connection.run(["kill-server"]); throw error }
        model.detach(); _ = try? await connection.run(["kill-server"])
    }

    func testExistingAgentObservationUpdatesAndClearsDisconnectedState() async throws {
        actor Status {
            var mode = "running"
            func set(_ value: String) { mode = value }
            func response() -> LocalHTTPResponse {
                .json(.object(["agents": .array([.object([
                    "id": .string("observed-agent"), "name": .string("Builder"), "mode": .string(mode),
                    "task_id": .string("task-1"), "log_path": .string("/tmp/task-1.log"), "session": .string("tsq-session-1"),
                    "pull_ago": .string("1s"), "work_dir": .string("/tmp"), "command": .string("claude"), "provider": .string("claude-code")
                ])])]))
            }
        }
        let status = Status(), server = try LocalHTTPServer { _ in await status.response() }
        let port = try await server.start()
        let model = ControlPanelModel(paths: TaskSquadPaths(home: FileManager.default.temporaryDirectory.appendingPathComponent("tsq-preview-fixture")), loadSavedAccount: false)
        model.configuration = try DaemonConfiguration.parse("""
        [ui]
        port = \(port)
        [[agents]]
        id = 'observed-agent'
        name = 'Builder'
        command = 'claude'
        work_dir = '/tmp'
        """)
        await model.observeAgents()
        XCTAssertEqual(model.observedAgents.first?.mode, "running")
        await status.set("waiting_input"); await model.observeAgents()
        XCTAssertEqual(model.observedAgents.first?.mode, "waiting_input")
        XCTAssertNotNil(model.observationDate)
        await server.stop(); await model.observeAgents()
        XCTAssertTrue(model.observedAgents.isEmpty); XCTAssertNil(model.observationDate)
        XCTAssertNotNil(model.observationError)
    }

    func testNativePreviewLayoutsAndTerminalRendering() throws {
        _ = NSApplication.shared
        setlocale(LC_CTYPE, "en_US.UTF-8")
        let markdown = "# Agent handoff\n\nA clear overview of **what changed**, why it matters, and what comes next.\n\n## Ready for review\n\n- [x] Inspect the running session\n- [x] Preserve exact JSON identifiers\n- [ ] Review the native interface\n\n> The terminal stays alive when you detach. Return whenever you need to work with the agent.\n\n```swift\nlet session = try await agent.attach()\nawait session.send(\"Continue with the tests\")\n```\n\n| Agent | Status |\n| --- | --- |\n| Builder | Running |\n| Reviewer | Waiting for input |"
        let blocks = MarkdownBlock.parse(markdown)
        let preview = ScrollView { VStack(alignment: .leading, spacing: 18) { ForEach(blocks) { MarkdownBlockView(block: $0) } }.padding(32).frame(maxWidth: 820, alignment: .leading).frame(maxWidth: .infinity) }.background(Color(nsColor: .textBackgroundColor))
        try render(preview, name: "markdown-light", appearance: .aqua)
        try render(preview, name: "markdown-dark", appearance: .darkAqua)
        let json = try JSONPreviewNode.parse(#"{"task_id":90071992547409931234,"subject":"Implement the native session workspace","status":"waiting_input","progress":0.85,"approved":true,"notes":null,"agents":[{"name":"Builder","provider":"claude-code"},{"name":"Reviewer","provider":"codex"}],"message":"All checks passed. Ready for your review."}"#)
        try render(JSONTreeView(nodes: json), name: "json-light", appearance: .aqua)
        try render(JSONTreeView(nodes: json), name: "json-dark", appearance: .darkAqua)
        let model = ControlPanelModel(paths: TaskSquadPaths(home: FileManager.default.temporaryDirectory.appendingPathComponent("tsq-preview-fixture")), loadSavedAccount: false)
        model.configuration = try DaemonConfiguration.parse("""
        [[agents]]
        id = 'builder'
        name = 'Builder'
        command = 'claude'
        work_dir = '/tmp/tasksquad'
        [[agents]]
        id = 'reviewer'
        name = 'Reviewer'
        command = 'codex'
        work_dir = '/tmp/tasksquad'
        """)
        model.selectedAgentID = "builder"
        try render(AgentWorkspace(model: model, attach: { _ in }), name: "agents-light", appearance: .aqua)
        let terminal = TerminalCanvas(frame: NSRect(x: 0, y: 0, width: 1000, height: 600))
        terminal.screen = TerminalScreen(text: "\u{1b}[1;38;2;125;207;255m  TASKSQUAD  /  Builder\u{1b}[0m\n\n  \u{1b}[32m✓\u{1b}[0m Config loaded\n  \u{1b}[32m✓\u{1b}[0m Connected to agent session\n\n  \u{1b}[1mReview changes\u{1b}[0m\n  ┌───────────────────────────────────────────────────┐\n  │  1. Continue with implementation                   │\n  │  2. Run verification                              │\n  │  3. Inspect logs                                  │\n  └───────────────────────────────────────────────────┘\n\n  Unicode: 猫 日本語 · e\u{301} · 🚀\n\n  > ", metadata: "100,30,4,14,1,0,0,0,0,0,0")
        terminal.lines = TerminalANSI.lines(terminal.screen!.text)
        XCTAssertEqual(TerminalANSI.columns("猫"), 2)
        XCTAssertEqual(TerminalANSI.columns("🇺🇸"), 2)
        XCTAssertEqual(TerminalANSI.columns("e\u{301}"), 1)
        try writeBitmap(terminal, name: "terminal")
    }
    private func until(_ condition: () -> Bool) async throws {
        let end = ContinuousClock.now.advanced(by: .seconds(5))
        while !condition(), ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(30)) }
        XCTAssertTrue(condition(), "UI model did not reach expected state")
    }
    private func render<V: View>(_ value: V, name: String, appearance: NSAppearance.Name) throws {
        let view = NSHostingView(rootView: value.background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 800), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        defer { window.contentView = nil }
        view.appearance = NSAppearance(named: appearance)
        view.frame = NSRect(x: 0, y: 0, width: 1000, height: 800)
        view.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        view.layoutSubtreeIfNeeded()
        try writeBitmap(view, name: name)
    }
    private func writeBitmap(_ view: NSView, name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["TSQ_UI_ARTIFACTS"] else { return }
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
        XCTAssertGreaterThan(png.count, 5000)
    }
}

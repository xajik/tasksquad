import Foundation
import TaskSquadCore

/// tmux, log and screenshot commands (Go: cmd/tmux, cmd/logs, cmd/screenshot).
enum LocalCommands {
    /// "tsq-…" names pass through; anything else becomes tsq-<first 8>, which tmux
    /// resolves by prefix against tsq-<full session ID> (Go: tmux.NormalizeSessionName).
    static func sessionName(_ argument: String) -> String {
        argument.hasPrefix("tsq-") ? argument : "tsq-" + argument.prefix(8)
    }

    static func sessions(_ c: CLIContext) async -> Int32 {
        guard let out = try? await c.tmux.run(["list-sessions", "-F", "#{session_name}\t#{session_windows} window(s)\tcreated #{t:session_created}"]) else {
            c.print("No active tsq sessions."); return 0
        }
        var found = false
        for line in out.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n") where line.hasPrefix("tsq-") {
            if !found { c.print("Active tsq sessions:"); found = true }
            c.print("  " + line)
        }
        if !found { c.print("No active tsq sessions.") }
        return 0
    }

    static func attach(_ args: [String], _ c: CLIContext) async -> Int32 {
        var session: String
        if let first = args.first { session = sessionName(first) } else {
            guard let out = try? await c.tmux.run(["list-sessions", "-F", "#{session_name}"]) else { c.print("No active tsq sessions."); return 0 }
            let sessions = out.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").filter { $0.hasPrefix("tsq-") }
            switch sessions.count {
            case 0: c.print("No active tsq sessions."); return 0
            case 1: session = sessions[0]
            default:
                c.print("Multiple active tsq sessions — specify one:")
                for name in sessions { c.print("  " + name) }
                c.print("\nUsage: tsq attach <taskID>")
                return 0
            }
        }
        c.print("Attaching to \(session) (detach: Ctrl-b d)")
        var environment = c.environment
        environment.removeValue(forKey: "TMUX")
        if c.interactive(c.tmux.executable, ["attach-session", "-t", session], environment) != 0 {
            c.printError("error: session \(GoFlagSet.goQuote(session)) not found or tmux unavailable")
            return 1
        }
        return 0
    }

    static func pane(_ args: [String], _ c: CLIContext) async -> Int32 {
        guard let first = args.first else { c.printError("usage: tsq pane <session> [--lines N]"); return 1 }
        let session = sessionName(first)
        let flags = GoFlagSet("pane", output: c.stderr)
        flags.int("lines", 200, "number of lines to capture from scrollback")
        try? flags.parse(Array(args.dropFirst())) // Go ignores the parse error and uses what it has
        let out = ((try? await c.tmux.run(["capture-pane", "-t", session, "-p", "-S", "-\(flags[int: "lines"])"])) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !out.isEmpty else { c.printError("no output captured — session \(GoFlagSet.goQuote(session)) may not exist"); return 1 }
        c.print(out)
        return 0
    }

    static func send(_ args: [String], _ c: CLIContext) async -> Int32 {
        guard let first = args.first else { c.printError("usage: tsq send <session> [<text>]"); return 1 }
        let session = sessionName(first)
        do {
            if args.count >= 2 {
                _ = try await c.tmux.run(["send-keys", "-t", session, args[1]])
                try await Task.sleep(for: .seconds(2)) // two calls: merged, Claude's TUI misses the Enter
            }
            _ = try await c.tmux.run(["send-keys", "-t", session, "C-m"])
        } catch {
            c.printError("error: exit status 1"); return 1 // Go reports exec.ExitError
        }
        return 0
    }

    static func logs(_ args: [String], _ c: CLIContext) -> Int32 {
        let logs = c.paths.logs
        /// Go's cmd/logs sanitizer: path separators to "-", ".." removed.
        func agentFolder(_ name: String) -> String {
            name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\\", with: "-").replacingOccurrences(of: "..", with: "")
        }
        func tail(_ url: URL) -> Int32 {
            guard let data = FileManager.default.contents(atPath: url.path) else { c.printError("log not found: \(url.path)"); return 1 }
            c.print("=== \(url.path) ===")
            c.stdout(String(decoding: data, as: UTF8.self))
            return 0
        }
        switch args.count {
        case 0:
            let day = c.now().formatted(Date.ISO8601FormatStyle(timeZone: c.timeZone).year().month().day().dateSeparator(.dash))
            return tail(logs.appendingPathComponent("daemon-\(day).log"))
        case 1:
            let folder = logs.appendingPathComponent(agentFolder(args[0]))
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else {
                c.printError("no logs found for agent \(GoFlagSet.goQuote(args[0])) (looked in \(folder.path))"); return 1
            }
            c.print("Task logs for agent \(GoFlagSet.goQuote(args[0])):")
            let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"; formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = c.timeZone
            for name in names.sorted() where name.hasSuffix(".log") {
                let url = folder.appendingPathComponent(name)
                var isDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue else { continue }
                let modified = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)
                c.print("  \(name.dropLast(4))  (\(formatter.string(from: modified)))")
            }
            return 0
        default:
            return tail(logs.appendingPathComponent(agentFolder(args[0])).appendingPathComponent(args[1] + ".log"))
        }
    }

    static func screenshot(_ args: [String], _ c: CLIContext) async -> Int32 {
        guard let first = args.first else { c.printError("usage: tsq screenshot <session> [--lines N] [--out <path>]"); return 1 }
        let session = sessionName(first)
        let flags = GoFlagSet("screenshot", output: c.stderr)
        flags.int("lines", 0, "lines of scrollback history to include (0 = visible pane only)")
        flags.string("out", "", "output PNG path (default: ~/.tasksquad/tmp/screenshots/<session>-<timestamp>.png)")
        do { try flags.parse(Array(args.dropFirst())) } catch { return 1 }
        let png: Data
        do { png = try await TerminalScreenshot.capture(session: session, scrollbackLines: flags[int: "lines"], tmux: c.tmux) }
        catch { c.printError("error: \(error.localizedDescription) — session \(GoFlagSet.goQuote(session)) may not exist"); return 1 }
        var out = flags[string: "out"]
        if out.isEmpty {
            let formatter = DateFormatter(); formatter.dateFormat = "yyyyMMdd-HHmmss"; formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = c.timeZone
            out = c.paths.root.appendingPathComponent("tmp/screenshots/\(session)-\(formatter.string(from: c.now())).png").path
        }
        let url = URL(fileURLWithPath: out)
        do { try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true) }
        catch { c.printError("error creating output dir: \(error.localizedDescription)"); return 1 }
        do { try png.write(to: url) } catch { c.printError("error writing screenshot: \(error.localizedDescription)"); return 1 }
        c.print(out)
        return 0
    }
}

/// Commands that call the running daemon's loopback hook server (Go: cmd/hooks, cmd/attach).
enum HookCommands {
    private static func post(_ path: String, port: Int, body: [String: String], what: String, _ c: CLIContext) async -> Int32 {
        var request = URLRequest(url: URL(string: "http://localhost:\(port)\(path)")!, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys, .withoutEscapingSlashes])
        let data: Data, response: URLResponse
        do { (data, response) = try await URLSession.shared.data(for: request) }
        catch { c.printError("error \(what): Post \"http://localhost:\(port)\(path)\": \(error.localizedDescription)"); return 1 }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        c.print("HTTP \(status): \(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))")
        return (200..<300).contains(status) ? 0 : 1
    }

    static func report(_ args: [String], _ c: CLIContext) async -> Int32 {
        let flags = GoFlagSet("report", output: c.stderr)
        flags.string("task", "", "task ID (required)")
        flags.string("status", "", "verdict: working_fine | resolved | cannot_help (required)")
        flags.string("summary", "", "one-line summary (required)")
        flags.string("found", "", "what the terminal showed")
        flags.string("action", "none", "what you sent, or none")
        flags.int("port", 7374, "hooks server port")
        do { try flags.parse(args) } catch { return 1 }
        guard !flags[string: "task"].isEmpty, !flags[string: "status"].isEmpty, !flags[string: "summary"].isEmpty else {
            c.printError("usage: tsq report --task <id> --status <status> --summary <summary> [--found <found>] [--action <action>]"); return 1
        }
        return await post("/hooks/supervisor", port: flags[int: "port"], body: [
            "task_id": flags[string: "task"], "status": flags[string: "status"], "summary": flags[string: "summary"],
            "found": flags[string: "found"], "action": flags[string: "action"]], what: "posting report", c)
    }

    static func sendImage(_ args: [String], _ c: CLIContext) async -> Int32 {
        let flags = GoFlagSet("attach", output: c.stderr)
        flags.string("task", "", "task ID (required)")
        flags.string("caption", "", "one-line description of the image")
        flags.int("port", 7374, "hooks server port")
        do { try flags.parse(args) } catch { return 1 }
        guard !flags[string: "task"].isEmpty, let path = flags.arguments.first else {
            c.printError("usage: tsq send-image --task <id> <path> [--caption <text>]"); return 1
        }
        return await post("/hooks/attach", port: flags[int: "port"], body: ["task_id": flags[string: "task"], "path": path, "caption": flags[string: "caption"]],
                          what: "posting attach", c)
    }

    static let skillUsage = """
    usage: tsq skill --name <name> --description <desc> [--file <path>]

    Hint: Skill content must be a Markdown file with YAML frontmatter.

    Expected Skill Format (SKILL.md):
    ┌──────────────────────────────────────────────────┐
    │ ---                                              │
    │ name: tsq-my-skill                               │
    │ description: brief summary of the skill          │
    │ ---                                              │
    │                                                  │
    │ ## When to use                                   │
    │ <condition that triggers this skill>             │
    │                                                  │
    │ ## Steps                                         │
    │ 1. First do X                                    │
    │ 2. Then do Y                                     │
    └──────────────────────────────────────────────────┘
    """

    static func skill(_ args: [String], _ c: CLIContext) async -> Int32 {
        let flags = GoFlagSet("skill", output: c.stderr)
        flags.string("name", "", "skill name, e.g. tsq-my-skill (required)")
        flags.string("description", "", "one-line description (required)")
        flags.string("file", "", "path to skill markdown file (reads stdin if omitted)")
        flags.int("port", 7374, "hooks server port")
        do { try flags.parse(args) } catch { return 1 }
        guard !flags[string: "name"].isEmpty, !flags[string: "description"].isEmpty else { c.printError(skillUsage); return 1 }
        let content: Data
        if !flags[string: "file"].isEmpty {
            guard let data = FileManager.default.contents(atPath: flags[string: "file"]) else {
                c.printError("error reading file: open \(flags[string: "file"]): no such file or directory"); return 1
            }
            content = data
        } else { content = c.stdin() }
        return await post("/hooks/skill", port: flags[int: "port"], body: ["name": flags[string: "name"], "description": flags[string: "description"],
                                                                         "content": String(decoding: content, as: UTF8.self)], what: "pushing skill", c)
    }
}

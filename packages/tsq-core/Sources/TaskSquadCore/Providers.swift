import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Ports packages/daemon/provider: how the engine launches and hooks each CLI.
/// Hook URLs, file locations and generated file contents match the Go daemon so
/// either implementation can serve the same work directories.
public enum ProviderKind: String, CaseIterable, Sendable {
    case claudeCode = "claude-code", gemini, opencode, pi, codex, stdout, claw

    private static let registry: [String: ProviderKind] = [
        "claude-code": .claudeCode, "claude": .claudeCode, "gemini": .gemini, "opencode": .opencode,
        "pi": .pi, "codex": .codex, "stdout": .stdout, "claw": .claw,
    ]

    /// CLI binary names used when the command's binary is not itself a registry key.
    public var cliName: String {
        switch self {
        case .claudeCode: "claude"
        case .gemini: "gemini"
        case .opencode: "opencode"
        case .pi: "pi"
        case .codex: "codex"
        case .stdout: ""
        case .claw: "agent"
        }
    }

    /// An explicit agents[].provider takes precedence; otherwise the command's
    /// binary name decides. Unknown binaries default to Claude Code, as in Go.
    public static func detect(command: String, override: String) -> ProviderKind {
        if !override.isEmpty, let kind = registry[override.lowercased()] { return kind }
        let first = command.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? command
        let binary = URL(fileURLWithPath: first).lastPathComponent.lowercased()
        if let kind = registry[binary] { return kind }
        return allCases.first { !$0.cliName.isEmpty && $0.cliName == binary } ?? .claudeCode
    }

    public var usesHooks: Bool { self != .stdout }
    /// Interactive providers run in tmux and receive the prompt as typed input;
    /// the rest receive `-p <prompt>` on a plain stdout pipe.
    public var interactive: Bool { self != .stdout && self != .pi }
    public var extraArguments: [String] {
        switch self {
        case .codex: ["--no-alt-screen"]
        case .opencode: ["--print-logs"]
        default: []
        }
    }
    public var environment: [String: String] { self == .gemini ? ["GEMINI_TRUST_WORKSPACE": "1"] : [:] }

    /// Codex queues its first prompt from argv; typing it at startup could answer
    /// a trust or onboarding dialog instead.
    public var promptInArguments: Bool { self == .codex }
    public func initialPromptArguments(_ prompt: String) -> [String] { self == .codex ? ["--", prompt] : [] }

    private static let skillInvocation = try! NSRegularExpression(pattern: "(^|[\\s])/(tsq-[A-Za-z0-9_-]+)\\b")
    /// Codex invokes skills as `$name`; other harnesses keep TaskSquad's `/name`.
    public func formatPrompt(_ prompt: String) -> String {
        guard self == .codex else { return prompt }
        return Self.skillInvocation.stringByReplacingMatches(in: prompt, range: NSRange(prompt.startIndex..., in: prompt),
                                                              withTemplate: "$1\\$$2")
    }

    /// Per-invocation hook configuration (preferred over writing into workDir).
    public func setupArguments(hooksPort: Int, agentID: String, taskID: String,
                               temporaryDirectory: URL = FileManager.default.temporaryDirectory) throws -> [String] {
        switch self {
        case .claudeCode:
            let url = temporaryDirectory.appendingPathComponent("tsq-settings-\(agentID)-\(taskID).json")
            try Self.claudeHooks(port: hooksPort, agentID: agentID, taskID: taskID).data.write(to: url)
            return ["--settings", url.path]
        case .codex:
            // url.Values.Encode: keys sorted, values query-escaped.
            let endpoint = "http://127.0.0.1:\(hooksPort)/hooks/codex?agent=\(GoJSON.queryEscape(agentID))&task_id=\(GoJSON.queryEscape(taskID))"
            // The endpoint is an argument, never interpolated into shell code; the
            // timeout keeps a stopped daemon from holding up a Codex turn.
            let argv: GoJSONValue = ["sh", "-c", "curl --silent --show-error --fail --max-time 5 -X POST \"$1\" -H 'Content-Type: application/json' -H \"Authorization: Bearer $TSQ_HOOK_TOKEN\" --data-binary \"$2\" >/dev/null",
                        "tsq-codex-notify", .string(endpoint)]
            return ["-c", "notify=" + argv.marshal()]
        default:
            return []
        }
    }

    /// Writes hook/plugin files into the work directory for CLIs without a
    /// per-invocation override.
    public func setup(workDir: String, hooksPort: Int, agentID: String, taskID: String, hookToken: String? = nil) throws {
        let root = URL(fileURLWithPath: workDir, isDirectory: true)
        let fileManager = FileManager.default
        switch self {
        case .gemini:
            // AfterAgent fires on every model turn: the completion signal, like Claude's Stop.
            let stop = "http://localhost:\(hooksPort)/hooks/stop?agent=\(agentID)&task_id=\(taskID)&provider=gemini"
            var hooks: [String: [GoJSONValue]] = ["AfterAgent": [Self.geminiGroup(name: "tasksquad-stop", url: stop)]]
            let event = "http://localhost:\(hooksPort)/hooks/event?agent=\(agentID)&task_id=\(taskID)&provider=gemini"
            for name in Self.geminiLifecycleEvents { hooks[name, default: []].append(Self.geminiGroup(name: "tasksquad-analytics", url: event)) }
            try Self.writeHooks(root.appendingPathComponent(".gemini/settings.json"), hooks: hooks)
        case .claw:
            try Self.writeManagedBlock(root.appendingPathComponent(".agent/settings.local.toml"),
                                       block: Self.clawHooks(port: hooksPort, agentID: agentID, taskID: taskID, hookToken: hookToken))
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: root.appendingPathComponent(".agent/settings.local.toml").path)
        case .opencode:
            let folder = root.appendingPathComponent(".opencode/plugins", isDirectory: true)
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
            try? fileManager.removeItem(at: folder.appendingPathComponent("tasksquad.mjs"))
            let analytics = ProviderTemplates.render(ProviderTemplates.openCodeAnalytics, port: hooksPort, agentID: agentID, taskID: taskID)
            var plugin = ProviderTemplates.render(ProviderTemplates.openCodePlugin, port: hooksPort, agentID: agentID, taskID: taskID)
            if let marker = plugin.range(of: "// @analytics") { plugin.replaceSubrange(marker, with: analytics) }
            try Data(plugin.utf8).write(to: folder.appendingPathComponent("tasksquad.ts"))
        case .pi:
            let folder = root.appendingPathComponent(".pi/extensions", isDirectory: true)
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data(ProviderTemplates.render(ProviderTemplates.piExtension, port: hooksPort, agentID: agentID, taskID: taskID).utf8)
                .write(to: folder.appendingPathComponent("tasksquad.ts"))
        case .claudeCode, .codex, .stdout:
            break
        }
    }

    // MARK: Generated configuration

    /// Tools that present a blocking TUI menu; their Pre/PostToolUse hooks gate
    /// raw keystroke forwarding while the menu is on screen.
    static let tuiBlockMatchers = ["AskUserQuestion"]

    /// Claude Code hooks forwarded to /hooks/event for session analytics
    /// (Go: provider/claudecode.go lifecycleEvents).
    static let claudeLifecycleEvents = [
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
        "PermissionDenied", "Notification", "SubagentStart", "SubagentStop", "PreCompact",
        "PostModelSwitch", "Stop", "StopFailure", "SessionEnd",
    ]
    /// Seconds. PreToolUse and UserPromptSubmit block until answered, so a wedged
    /// daemon must never stall the session for Claude's 600s default.
    static let lifecycleHookTimeout = 5

    static func claudeHooks(port: Int, agentID: String, taskID: String) -> GoJSONValue {
        let base = "http://localhost:\(port)/hooks"
        let query = "agent=\(agentID)&task_id=\(taskID)"
        func tui(_ state: String) -> [GoJSONValue] {
            tuiBlockMatchers.map { ["matcher": .string($0), "hooks": [["type": "http", "url": .string("\(base)/tui-blocked?\(query)&state=\(state)")]]] }
        }
        var hooks: [String: [GoJSONValue]] = [
            "Stop": [httpHook("\(base)/stop?\(query)")],
            "StopFailure": [httpHook("\(base)/stop?\(query)&failure=true")],
            "PreToolUse": tui("on"),
            "PostToolUse": tui("off"),
        ]
        let eventURL = "\(base)/event?\(query)"
        for event in claudeLifecycleEvents {
            var hook: GoJSONValue = ["type": "http", "url": .string(eventURL), "timeout": .int(lifecycleHookTimeout)]
            if event == "SessionStart" {
                // SessionStart doesn't deliver to http hooks, and a command hook's
                // stdout is injected into the model's context: discard curl's output.
                hook = ["type": "command", "timeout": .int(lifecycleHookTimeout), "command":
                    .string("curl -s -m \(lifecycleHookTimeout) -X POST -H 'Content-Type: application/json' -H \"Authorization: Bearer $TSQ_HOOK_TOKEN\" --data-binary @- '\(eventURL)' >/dev/null 2>&1 || true")]
            }
            hooks[event, default: []].append(["matcher": "*", "hooks": [hook]])
        }
        for name in hooks.keys {
            hooks[name] = hooks[name]?.map { group in
                guard var object = group.object, let entries = object["hooks"]?.array else { return group }
                object["hooks"] = .array(entries.map { entry in
                    guard var item = entry.object, item["type"]?.string == "http" else { return entry }
                    item["headers"] = ["Authorization": "Bearer $TSQ_HOOK_TOKEN"]
                    item["allowedEnvVars"] = ["TSQ_HOOK_TOKEN"]
                    return .object(item)
                })
                return .object(object)
            }
        }
        return ["hooks": .object(hooks.mapValues(GoJSONValue.array))]
    }

    /// Gemini analytics events; AfterModel is left out as it fires per streamed chunk.
    static let geminiLifecycleEvents = ["SessionStart", "BeforeAgent", "AfterAgent", "BeforeModel", "BeforeTool", "AfterTool",
                                        "Notification", "PreCompress", "SessionEnd"]

    /// POSTs the hook payload and answers `{}`, as Gemini's command-hook contract requires.
    private static func geminiGroup(name: String, url: String) -> GoJSONValue {
        ["matcher": "*", "hooks": [[
            "name": .string(name), "type": "command", "timeout": 5000,
            "command": .string("curl -sS -X POST \"\(url)\" -H \"Content-Type: application/json\" -H \"Authorization: Bearer $TSQ_HOOK_TOKEN\" -d @- > /dev/null 2>&1; printf '{}'"),
        ]]]
    }

    /// agent-code's events mapped to the names the lifecycle collector reads.
    static let clawLifecycleEvents = [("session_start", "SessionStart"), ("user_prompt_submit", "UserPromptSubmit"),
                                      ("stop", "Stop"), ("pre_compact", "PreCompact"), ("session_stop", "SessionEnd")]
    /// agent-code 0.21 built-in tools. Its hooks POST no body, so each tool needs
    /// its own pre/post pair to be named in the URL.
    static let clawTools = [
        "Agent", "AskUserQuestion", "Bash", "Brief", "Config", "CronCreate", "CronDelete", "CronList",
        "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree", "FileEdit", "FileRead", "FileWrite",
        "Glob", "Grep", "ListMcpResources", "LSP", "McpAuth", "Monitor", "MultiEdit", "NotebookEdit",
        "PowerShell", "ReadMcpResource", "RemoteTrigger", "REPL", "SendMessage", "Skill", "Sleep",
        "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "TodoWrite",
        "ToolSearch", "WebFetch", "WebSearch",
    ]
    static let clawManagedStart = "# >>> TaskSquad hooks (managed by tsq; replaced on every task) >>>"
    static let clawManagedEnd = "# <<< TaskSquad hooks <<<"

    /// agent-code loads TOML only (settings.toml, then settings.local.toml).
    static func clawHooks(port: Int, agentID: String, taskID: String, hookToken: String? = nil) -> String {
        var block = clawManagedStart + "\n"
        func hook(_ event: String, _ tool: String, _ url: String) {
            block += "[[hooks]]\nevent = \(goQuote(event))\n"
            if !tool.isEmpty { block += "tool_name = \(goQuote(tool))\n" }
            var authenticated = url
            if let hookToken { authenticated += "&hook_token=" + hookToken }
            block += "action = { type = \"http\", url = \(goQuote(authenticated)) }\n\n"
        }
        hook("stop", "", "http://localhost:\(port)/hooks/stop?agent=\(agentID)&task_id=\(taskID)")
        let event = "http://localhost:\(port)/hooks/event?agent=\(agentID)&task_id=\(taskID)&provider=claw"
        for (native, canonical) in clawLifecycleEvents { hook(native, "", event + "&event=" + canonical) }
        for tool in clawTools {
            hook("pre_tool_use", tool, event + "&event=PreToolUse&tool=" + tool)
            hook("post_tool_use", tool, event + "&event=PostToolUse&tool=" + tool)
        }
        return block + clawManagedEnd + "\n"
    }

    /// Go's %q for the ASCII values used here (quotes and backslashes escaped).
    private static func goQuote(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// Replaces the TaskSquad block (appending when absent), keeping the rest of the file.
    static func writeManagedBlock(_ url: URL, block: String) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var rest = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        if let start = rest.range(of: clawManagedStart) {
            if let end = rest.range(of: clawManagedEnd, range: start.lowerBound..<rest.endIndex) {
                var tail = String(rest[end.upperBound...])
                if tail.hasPrefix("\n") { tail.removeFirst() }
                rest = String(rest[..<start.lowerBound]) + tail
            } else { rest = String(rest[..<start.lowerBound]) }
        }
        if !rest.isEmpty && !rest.hasSuffix("\n") { rest += "\n" }
        let fd = open(url.path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        guard fchmod(fd, 0o600) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        try handle.write(contentsOf: Data((rest + block).utf8))
    }

    private static func httpHook(_ url: String) -> GoJSONValue {
        ["matcher": "*", "hooks": [["type": "http", "url": .string(url)]]]
    }

    /// Merges into an existing settings file, replacing only its "hooks" key
    /// (Go: provider/settings.go, json.Unmarshal into a map then MarshalIndent).
    private static func writeHooks(_ url: URL, hooks: [String: [GoJSONValue]]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var existing: [String: GoJSONValue] = [:]
        if let data = try? Data(contentsOf: url), let object = try? GoJSONValue.parse(data, strict: true).float64.object { existing = object }
        existing["hooks"] = .object(hooks.mapValues(GoJSONValue.array))
        try Data(GoJSONValue.object(existing).marshal(indent: "  ").utf8).write(to: url)
    }
}

/// Ports packages/daemon/adapter: normalized hook payloads and transcript reads.
public struct HookStopEvent: Equatable, Sendable {
    public var reason = ""
    public var transcriptPath = ""
    public var hookMessage = ""
    public var isFailure = false
    public var sessionID = ""
}

public enum HookAdapter {
    /// json.Unmarshal of a hook body into a map; anything else is an empty payload.
    static func object(_ body: Data) -> [String: GoJSONValue] {
        (try? GoJSONValue.parse(body, strict: true))?.object ?? [:]
    }

    /// `provider` is the hook URL's `provider` query value; unknown/empty is Claude.
    public static func parseStop(provider: String, body: Data, isFailure: Bool) -> HookStopEvent {
        let p = object(body)
        func s(_ key: String) -> String { p[key]?.string ?? "" }
        switch provider {
        case "stdout":
            return HookStopEvent()
        case "codex":
            return HookStopEvent(reason: s("error_type"), transcriptPath: s("transcript_path"),
                                 hookMessage: s("last-assistant-message"), isFailure: isFailure, sessionID: s("thread-id"))
        case "gemini":
            return HookStopEvent(reason: s("reason"), transcriptPath: s("transcript_path"), hookMessage: s("prompt_response"),
                                 isFailure: isFailure || s("reason") == "error", sessionID: s("session_id"))
        case "opencode", "pi":
            // The OpenCode plugin reports its main (non-subagent) session; Pi's is in its session file name.
            return HookStopEvent(reason: s("stop_reason"), transcriptPath: s("transcript_path"), hookMessage: s("message"),
                                 isFailure: isFailure || s("stop_reason") == "error",
                                 sessionID: provider == "opencode" ? s("session_id") : piSessionID(transcriptPath: s("transcript_path")))
        default: // claude-code, claw
            let sessionID = provider == "claw" ? "" : s("session_id")
            if isFailure {
                return HookStopEvent(reason: s("error_type"), transcriptPath: s("transcript_path"), isFailure: true, sessionID: sessionID)
            }
            return HookStopEvent(reason: s("stop_reason"), transcriptPath: s("transcript_path"),
                                 hookMessage: s("last_assistant_message"), isFailure: s("stop_reason") == "error", sessionID: sessionID)
        }
    }

    /// The session ID in a Pi session file name, <timestamp>_<id>.jsonl — the ID
    /// `pi --session <id>` resumes (Go: adapter.PiSessionID). "" otherwise.
    public static func piSessionID(transcriptPath: String) -> String {
        let name = (transcriptPath as NSString).lastPathComponent
        guard name.hasSuffix(".jsonl") else { return "" }
        let stem = name.dropLast(".jsonl".count)
        guard let underscore = stem.firstIndex(of: "_") else { return "" }
        let id = stem[stem.index(after: underscore)...]
        return id.isEmpty || id.contains("_") || id.contains("/") ? "" : String(id)
    }

    public static func parseNotification(body: Data) -> (message: String, transcriptPath: String) {
        let p = object(body)
        return (p["message"]?.string ?? "", p["transcript_path"]?.string ?? "")
    }

    /// The CLI's own session ID in a Notification payload. Claude Code's
    /// Notification can fire before the turn's Stop, so it pins the session too
    /// (Go: Claude/GeminiAdapter.ParseNotification). Other providers don't report one.
    public static func notificationSessionID(provider: String, body: Data) -> String {
        switch provider {
        case "stdout", "codex", "opencode", "pi", "claw": return ""
        default: return object(body)["session_id"]?.string ?? ""
        }
    }

    public static func parseAfterAgent(provider: String, body: Data) -> (response: String, transcriptPath: String) {
        guard provider == "gemini" else { return ("", "") }
        let p = object(body)
        return (p["prompt_response"]?.string ?? "", p["transcript_path"]?.string ?? "")
    }

    /// Returns the last assistant message in the provider's transcript, or "".
    public static func extractTranscript(provider: ProviderKind, path: String) -> String {
        guard !path.isEmpty, let data = FileManager.default.contents(atPath: path), !data.isEmpty else { return "" }
        switch provider {
        case .claudeCode, .claw: return claudeTranscript(data)
        case .gemini, .opencode: return geminiTranscript(data)
        case .pi: return piTranscript(data)
        case .codex, .stdout: return ""
        }
    }

    private static func texts(_ content: GoJSONValue?) -> [String] {
        (content?.array ?? []).compactMap { block in
            guard block["type"]?.string == "text", let text = block["text"]?.string, !text.isEmpty else { return nil }
            return text
        }
    }

    private static func claudeTranscript(_ data: Data) -> String {
        var last = ""
        for line in data.split(separator: 10) {
            guard let entry = try? GoJSONValue.parse(Data(line), strict: true), entry.object != nil else { continue }
            let message = entry["message"]
            guard entry["type"]?.string == "assistant" || message?["role"]?.string == "assistant" else { continue }
            let parts = texts(message?["content"])
            if !parts.isEmpty { last = parts.joined(separator: "\n") }
        }
        return last.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func geminiTranscript(_ data: Data) -> String {
        guard let document = try? GoJSONValue.parse(data, strict: true),
              let messages = document["messages"]?.array else { return "" }
        for message in messages.reversed() where ["gemini", "assistant"].contains(message["type"]?.string ?? "") {
            if let text = message["content"]?.string { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
            let parts = (message["content"]?.array ?? []).compactMap { block -> String? in
                guard let text = block["text"]?.string, !text.isEmpty else { return nil }
                return text
            }
            if !parts.isEmpty { return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        return ""
    }

    private static func piTranscript(_ data: Data) -> String {
        for line in data.split(separator: 10).reversed() {
            guard let entry = try? GoJSONValue.parse(Data(line), strict: true),
                  entry["type"]?.string == "message",
                  let message = entry["message"], message["role"]?.string == "assistant" else { continue }
            if let text = message["content"]?.string { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
            let parts = texts(message["content"])
            if !parts.isEmpty { return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        return ""
    }
}

/// Ports packages/daemon/provider/resume.go: reopening a provider CLI's own
/// session when a task's process is gone, so it keeps its history instead of
/// getting the thread replayed as plain text.
extension ProviderKind {
    public var resumable: Bool { [.claudeCode, .codex, .gemini, .opencode, .pi].contains(self) }

    /// Whether a hook whose session_id differs from the task's pinned CLI session
    /// is rejected (Go: strictSessionPin). Gemini's is only recorded: its hooks come
    /// from the work dir's shared settings, and turns reported under another session
    /// (e.g. subagents) must not leave the task stuck running.
    public static func strictSessionPin(provider: String) -> Bool { provider != "gemini" }

    private static let resumeID = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    private static let codexRolloutPrefix = try! NSRegularExpression(pattern: "^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}$")

    private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
        regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    /// Whether id is safe to pass to a CLI as a session ID (never a flag or path).
    public static func validResumeID(_ id: String) -> Bool {
        matches(resumeID, id) && !id.contains("..")
    }

    /// `arguments` (everything after the binary) changed to reopen session id.
    /// initialPromptArguments are appended afterwards.
    public func resumeArguments(_ arguments: [String], id: String) -> [String] {
        switch self {
        case .claudeCode, .gemini: arguments + ["--resume", id]
        case .codex: ["resume"] + arguments + [id] // `codex resume [options] <id> -- <prompt>`
        case .opencode: arguments + ["--session", id]
        // Before the one-shot `-p <reply>`; --session reopens an existing session
        // (--session-id would silently create an empty one when it is missing).
        case .pi: ["--session", id] + arguments
        default: arguments
        }
    }

    /// Whether session id is in the CLI's local session store. `command` is the
    /// agent's configured command (its first field is the CLI) and `workDir` the
    /// directory the CLI runs in; only OpenCode needs them.
    public func canResume(id: String, command: String = "", workDir: String = "",
                          environment: [String: String] = ProcessInfo.processInfo.environment) async -> Bool {
        guard resumable, Self.validResumeID(id) else { return false }
        let fm = FileManager.default
        func root(_ variable: String, _ directory: String) -> URL {
            if let value = environment[variable], !value.isEmpty { return URL(fileURLWithPath: value, isDirectory: true) }
            return TaskSquadPaths.userHome(environment: environment).appendingPathComponent(directory, isDirectory: true)
        }
        switch self {
        case .claudeCode:
            let projects = root("CLAUDE_CONFIG_DIR", ".claude").appendingPathComponent("projects", isDirectory: true)
            let dirs = (try? fm.contentsOfDirectory(atPath: projects.path)) ?? []
            return dirs.contains { fm.fileExists(atPath: projects.appendingPathComponent($0).appendingPathComponent(id + ".jsonl").path) }
        case .codex:
            let sessions = root("CODEX_HOME", ".codex").appendingPathComponent("sessions", isDirectory: true)
            let suffix = "-" + id + ".jsonl"
            guard let walker = fm.enumerator(atPath: sessions.path) else { return false }
            for case let path as String in walker.allObjects {
                let name = (path as NSString).lastPathComponent
                if name.hasSuffix(suffix), Self.matches(Self.codexRolloutPrefix, String(name.dropLast(suffix.count))) { return true }
            }
            return false
        case .gemini:
            // ~/.gemini/tmp/<project hash>/chats/*.json; names carry only part of the UUID.
            let tmp = TaskSquadPaths.userHome(environment: environment).appendingPathComponent(".gemini/tmp", isDirectory: true)
            let needle = Data(("\"" + id + "\"").utf8)
            for project in (try? fm.contentsOfDirectory(atPath: tmp.path)) ?? [] {
                let chats = tmp.appendingPathComponent(project).appendingPathComponent("chats", isDirectory: true)
                for file in (try? fm.contentsOfDirectory(atPath: chats.path)) ?? [] where file.hasSuffix(".json") {
                    if let data = fm.contents(atPath: chats.appendingPathComponent(file).path), data.range(of: needle) != nil { return true }
                }
            }
            return false
        case .pi:
            // <sessions>/<encoded cwd>/<timestamp>_<id>.jsonl
            let sessions: URL
            if let dir = environment["PI_CODING_AGENT_SESSION_DIR"], !dir.isEmpty { sessions = URL(fileURLWithPath: dir, isDirectory: true) }
            else { sessions = root("PI_CODING_AGENT_DIR", ".pi/agent").appendingPathComponent("sessions", isDirectory: true) }
            // Only a session recorded for workDir: resumed from another directory, Pi asks
            // "Fork this session into current directory? [y/N]" and, with no terminal,
            // exits 0 without running the turn.
            let suffix = "_" + id + ".jsonl"
            let want = URL(fileURLWithPath: workDir).resolvingSymlinksInPath().standardizedFileURL.path
            func recordedHere(_ file: URL) -> Bool {
                guard let data = fm.contents(atPath: file.path),
                      let header = try? JSONDecoder().decode(JSONValue.self, from: data.prefix { $0 != 10 }),
                      header["type"]?.string == "session", let cwd = header["cwd"]?.string, !workDir.isEmpty else { return false }
                return URL(fileURLWithPath: cwd).resolvingSymlinksInPath().standardizedFileURL.path == want
            }
            var candidates = ((try? fm.contentsOfDirectory(atPath: sessions.path)) ?? []).filter { $0.hasSuffix(suffix) }.map { sessions.appendingPathComponent($0) }
            for project in (try? fm.contentsOfDirectory(atPath: sessions.path)) ?? [] {
                let folder = sessions.appendingPathComponent(project)
                candidates += ((try? fm.contentsOfDirectory(atPath: folder.path)) ?? []).filter { $0.hasSuffix(suffix) }.map { folder.appendingPathComponent($0) }
            }
            return candidates.contains(where: recordedHere)
        case .opencode:
            // Sessions live in a SQLite database; ask the CLI, scoped to the project in workDir.
            let binary = command.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? cliName
            guard let executable = ExecutableLocator.find(binary, environment: environment) else { return false }
            let output = OutputBuffer()
            let listing = ProcessSpecification(executable: executable, arguments: ["session", "list", "--format", "json"],
                                               directory: workDir.isEmpty ? nil : workDir, environment: environment)
            let exit = await withTaskGroup(of: ProcessExit?.self) { group in
                group.addTask { try? await NativeProcess.run(listing, output: { channel, data in
                    if channel == .stdout { await output.append(data) }
                }) }
                group.addTask { try? await Task.sleep(for: .seconds(15)); return nil }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }
            guard exit?.code == 0 else { return false }
            return Self.openCodeListHas(await output.data, id: id)
        default:
            return false
        }
    }

    /// Whether `opencode session list --format json` output lists session id.
    static func openCodeListHas(_ data: Data, id: String) -> Bool {
        guard let sessions = try? JSONDecoder().decode([JSONValue].self, from: data) else { return false }
        return sessions.contains { $0["id"]?.string == id }
    }
}

private actor OutputBuffer {
    private(set) var data = Data()
    func append(_ chunk: Data) { data.append(chunk) }
}

import Foundation

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
            try Self.json(Self.claudeHooks(port: hooksPort, agentID: agentID, taskID: taskID)).write(to: url)
            return ["--settings", url.path]
        case .codex:
            var components = URLComponents(string: "http://127.0.0.1:\(hooksPort)/hooks/codex")!
            components.queryItems = [URLQueryItem(name: "agent", value: agentID), URLQueryItem(name: "task_id", value: taskID)]
            // The endpoint is an argument, never interpolated into shell code; the
            // timeout keeps a stopped daemon from holding up a Codex turn.
            let argv = ["sh", "-c", "curl --silent --show-error --fail --max-time 5 -X POST \"$1\" -H 'Content-Type: application/json' --data-binary \"$2\" >/dev/null",
                        "tsq-codex-notify", components.string!]
            return ["-c", "notify=" + String(decoding: try Self.json(argv, pretty: false), as: UTF8.self)]
        default:
            return []
        }
    }

    /// Writes hook/plugin files into the work directory for CLIs without a
    /// per-invocation override.
    public func setup(workDir: String, hooksPort: Int, agentID: String, taskID: String) throws {
        let root = URL(fileURLWithPath: workDir, isDirectory: true)
        let fileManager = FileManager.default
        switch self {
        case .gemini:
            let stop = "http://localhost:\(hooksPort)/hooks/stop?agent=\(agentID)&task_id=\(taskID)&provider=gemini"
            try Self.writeHooks(root.appendingPathComponent(".gemini/settings.json"), hooks: [
                "AfterAgent": [["matcher": "*", "hooks": [[
                    "name": "tasksquad-stop", "type": "command", "timeout": 5000,
                    "command": "curl -sS -X POST \"\(stop)\" -H \"Content-Type: application/json\" -d @- > /dev/null 2>&1; printf '{}'",
                ]]]],
            ])
        case .claw:
            try Self.writeHooks(root.appendingPathComponent(".agent/settings.json"), hooks: [
                "Stop": [Self.httpHook("http://localhost:\(hooksPort)/hooks/stop?agent=\(agentID)&task_id=\(taskID)")],
                "StopFailure": [Self.httpHook("http://localhost:\(hooksPort)/hooks/stop?agent=\(agentID)&task_id=\(taskID)&failure=true")],
            ])
        case .opencode:
            let folder = root.appendingPathComponent(".opencode/plugins", isDirectory: true)
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
            try? fileManager.removeItem(at: folder.appendingPathComponent("tasksquad.mjs"))
            try Data(Self.openCodePlugin(port: hooksPort, agentID: agentID, taskID: taskID).utf8)
                .write(to: folder.appendingPathComponent("tasksquad.ts"))
        case .pi:
            let folder = root.appendingPathComponent(".pi/extensions", isDirectory: true)
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data(Self.piExtension(port: hooksPort, agentID: agentID, taskID: taskID).utf8)
                .write(to: folder.appendingPathComponent("tasksquad.ts"))
        case .claudeCode, .codex, .stdout:
            break
        }
    }

    // MARK: Generated configuration

    /// Tools that present a blocking TUI menu; their Pre/PostToolUse hooks gate
    /// raw keystroke forwarding while the menu is on screen.
    static let tuiBlockMatchers = ["AskUserQuestion"]

    static func claudeHooks(port: Int, agentID: String, taskID: String) -> [String: Any] {
        let base = "http://localhost:\(port)/hooks"
        let query = "agent=\(agentID)&task_id=\(taskID)"
        func tui(_ state: String) -> [[String: Any]] {
            tuiBlockMatchers.map { ["matcher": $0, "hooks": [["type": "http", "url": "\(base)/tui-blocked?\(query)&state=\(state)"]]] }
        }
        return ["hooks": [
            "Stop": [httpHook("\(base)/stop?\(query)")],
            "StopFailure": [httpHook("\(base)/stop?\(query)&failure=true")],
            "PreToolUse": tui("on"),
            "PostToolUse": tui("off"),
        ]]
    }

    private static func httpHook(_ url: String) -> [String: Any] {
        ["matcher": "*", "hooks": [["type": "http", "url": url]]]
    }

    private static func json(_ value: Any, pretty: Bool = false) throws -> Data {
        var options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
        if pretty { options.insert(.prettyPrinted) }
        return try JSONSerialization.data(withJSONObject: value, options: options)
    }

    /// Merges into an existing settings file, replacing only its "hooks" key.
    private static func writeHooks(_ url: URL, hooks: [String: Any]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var existing: [String: Any] = [:]
        if let data = try? Data(contentsOf: url),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { existing = object }
        existing["hooks"] = hooks
        try json(existing, pretty: true).write(to: url)
    }

    static func openCodePlugin(port: Int, agentID: String, taskID: String) -> String {
        let stop = "/hooks/stop?agent=\(agentID)&task_id=\(taskID)&provider=opencode"
        return """
        // Auto-generated by tsq daemon — do not edit

        export const TaskSquadPlugin = async ({ client }) => {
          await client.app.log({ body: { service: "tasksquad", level: "info", message: "Plugin initialized" } })

          const post = async (path, body) => {
            try {
              await fetch("http://localhost:\(port)" + path, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
              })
            } catch (e) {
              await client.app.log({ body: { service: "tasksquad", level: "error", message: "hook error: " + e.message } })
            }
          }

          const messageCache = new Map()
          let pendingToolCount = 0
          let sessionIdleSent = false

          return {
            "event": async (input) => {
              const { event } = input

              if (event.type === "message.part.updated" && event.properties?.part) {
                const part = event.properties.part
                if (part.type === "text" && part.messageID) {
                  if (!messageCache.has(part.messageID)) {
                    messageCache.set(part.messageID, { sessionID: part.sessionID, textParts: [], completed: false })
                  }
                  const cached = messageCache.get(part.messageID)
                  const existing = cached.textParts.find(p => p.id === part.id)
                  if (existing) {
                    existing.text = part.text || ""
                  } else {
                    cached.textParts.push({ id: part.id, text: part.text || "" })
                  }
                }
              }

              if (event.type === "message.updated" && event.properties?.info) {
                const info = event.properties.info
                if (info.role === "assistant" && info.time?.completed && messageCache.has(info.id)) {
                  messageCache.get(info.id).completed = true
                }
              }

              if (event.type === "tool.execute.before") {
                pendingToolCount++
                await client.app.log({ body: { service: "tasksquad", level: "info", message: "tool.execute.before: " + pendingToolCount } })
              }

              if (event.type === "tool.execute.after") {
                pendingToolCount = Math.max(0, pendingToolCount - 1)
                await client.app.log({ body: { service: "tasksquad", level: "info", message: "tool.execute.after: pending=" + pendingToolCount } })
                // When tools complete and session goes idle, send stop hook
                if (pendingToolCount === 0 && !sessionIdleSent) {
                  let lastCompleted = null
                  for (const [, cached] of messageCache.entries()) {
                    if (cached.completed) lastCompleted = cached
                  }
                  const message = lastCompleted ? lastCompleted.textParts.map(p => p.text).join("") : ""
                  await post("\(stop)", { stop_reason: "idle", message })
                  sessionIdleSent = true
                }
              }

              if (event.type === "session.idle") {
                await client.app.log({ body: { service: "tasksquad", level: "info", message: "session.idle pending=" + pendingToolCount } })
                if (pendingToolCount === 0 && !sessionIdleSent) {
                  let lastCompleted = null
                  for (const [, cached] of messageCache.entries()) {
                    if (cached.completed) lastCompleted = cached
                  }
                  const message = lastCompleted ? lastCompleted.textParts.map(p => p.text).join("") : ""
                  await post("\(stop)", { stop_reason: "idle", message })
                  sessionIdleSent = true
                }
              }

              if (event.type === "session.error") {
                await client.app.log({ body: { service: "tasksquad", level: "error", message: "session.error" } })
                await post("\(stop)", { stop_reason: "error", message: event.properties?.error?.message || "Unknown error" })
              }

              // Reset on new user message to handle multiple turns
              if (event.type === "session.updated" && event.properties?.info?.role === "user") {
                sessionIdleSent = false
                messageCache.clear()
                pendingToolCount = 0
              }
            },
          }
        }

        """
    }

    static func piExtension(port: Int, agentID: String, taskID: String) -> String {
        """
        // Auto-generated by tsq daemon — do not edit

        export default function(pi) {
          const post = async (path, body, signal) => {
            try {
              await fetch("http://localhost:\(port)" + path, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body), signal,
              })
            } catch (e) {
              console.error("[tasksquad] hook error:", e?.message)
            }
          }

          const extractText = (content) =>
            (content || []).filter(c => c.type === "text").map(c => c.text || "").join("")

          let lastAssistantMessage = ""

          pi.on("before_agent_start", async (_event, _ctx) => {
            lastAssistantMessage = ""
          })

          pi.on("message_end", async (event, _ctx) => {
            if (event.message?.role === "assistant") {
              const text = extractText(event.message.content)
              if (text) lastAssistantMessage = text
            }
          })

          pi.on("agent_end", async (event, ctx) => {
            const msgs = event.messages || []
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "assistant") {
                const text = extractText(msgs[i].content)
                if (text) { lastAssistantMessage = text; break }
              }
            }
            const transcriptPath = ctx.sessionManager?.getSessionFile?.() ?? ""
            await post(
              "/hooks/stop?agent=\(agentID)&task_id=\(taskID)&provider=pi",
              { stop_reason: "idle", message: lastAssistantMessage, transcript_path: transcriptPath },
              ctx.signal
            )
          })
        }

        """
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
    private static func object(_ body: Data) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
    }

    /// `provider` is the hook URL's `provider` query value; unknown/empty is Claude.
    public static func parseStop(provider: String, body: Data, isFailure: Bool) -> HookStopEvent {
        let p = object(body)
        func s(_ key: String) -> String { p[key] as? String ?? "" }
        switch provider {
        case "stdout":
            return HookStopEvent()
        case "codex":
            return HookStopEvent(reason: s("error_type"), transcriptPath: s("transcript_path"),
                                 hookMessage: s("last-assistant-message"), isFailure: isFailure, sessionID: s("thread-id"))
        case "gemini":
            return HookStopEvent(reason: s("reason"), transcriptPath: s("transcript_path"), hookMessage: s("prompt_response"),
                                 isFailure: isFailure || s("reason") == "error")
        case "opencode", "pi":
            return HookStopEvent(reason: s("stop_reason"), transcriptPath: s("transcript_path"), hookMessage: s("message"),
                                 isFailure: isFailure || s("stop_reason") == "error")
        default: // claude-code, claw
            let sessionID = provider == "claw" ? "" : s("session_id")
            if isFailure {
                return HookStopEvent(reason: s("error_type"), transcriptPath: s("transcript_path"), isFailure: true, sessionID: sessionID)
            }
            return HookStopEvent(reason: s("stop_reason"), transcriptPath: s("transcript_path"),
                                 hookMessage: s("last_assistant_message"), isFailure: s("stop_reason") == "error", sessionID: sessionID)
        }
    }

    public static func parseNotification(body: Data) -> (message: String, transcriptPath: String) {
        let p = object(body)
        return (p["message"] as? String ?? "", p["transcript_path"] as? String ?? "")
    }

    public static func parseAfterAgent(provider: String, body: Data) -> (response: String, transcriptPath: String) {
        guard provider == "gemini" else { return ("", "") }
        let p = object(body)
        return (p["prompt_response"] as? String ?? "", p["transcript_path"] as? String ?? "")
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

    private static func texts(_ content: Any?) -> [String] {
        (content as? [[String: Any]] ?? []).compactMap { block in
            guard block["type"] as? String == "text", let text = block["text"] as? String, !text.isEmpty else { return nil }
            return text
        }
    }

    private static func claudeTranscript(_ data: Data) -> String {
        var last = ""
        for line in data.split(separator: 10) {
            guard let entry = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
            let message = entry["message"] as? [String: Any] ?? [:]
            guard entry["type"] as? String == "assistant" || message["role"] as? String == "assistant" else { continue }
            let parts = texts(message["content"])
            if !parts.isEmpty { last = parts.joined(separator: "\n") }
        }
        return last.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func geminiTranscript(_ data: Data) -> String {
        guard let document = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let messages = document["messages"] as? [[String: Any]] else { return "" }
        for message in messages.reversed() where ["gemini", "assistant"].contains(message["type"] as? String ?? "") {
            if let text = message["content"] as? String { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
            let parts = (message["content"] as? [[String: Any]] ?? []).compactMap { block -> String? in
                guard let text = block["text"] as? String, !text.isEmpty else { return nil }
                return text
            }
            if !parts.isEmpty { return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        return ""
    }

    private static func piTranscript(_ data: Data) -> String {
        for line in data.split(separator: 10).reversed() {
            guard let entry = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                  entry["type"] as? String == "message",
                  let message = entry["message"] as? [String: Any], message["role"] as? String == "assistant" else { continue }
            if let text = message["content"] as? String { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
            let parts = texts(message["content"])
            if !parts.isEmpty { return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) }
        }
        return ""
    }
}

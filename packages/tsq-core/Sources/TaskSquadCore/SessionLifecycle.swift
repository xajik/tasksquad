import Foundation

/// Hook-observed session analytics: tool latency and failures, permission
/// denials, subagent runs, compactions, turn timing and why the session
/// ended. Port of packages/daemon/metrics/{lifecycle,codex_lifecycle}.go.
/// Counts and names only — never prompt or tool content. Owned by the engine actor
/// until taken for a report, then handed whole to the report task (never shared).
final class SessionLifecycle: @unchecked Sendable {
    struct ToolStat: Equatable {
        var calls = 0, errors = 0, denied = 0, totalMs = 0, maxMs = 0, subagent = 0, unfinished = 0
        var json: JSONValue {
            .object(["calls": .number(Double(calls)), "errors": .number(Double(errors)), "denied": .number(Double(denied)),
                     "total_ms": .number(Double(totalMs)), "max_ms": .number(Double(maxMs)),
                     "subagent_calls": .number(Double(subagent)), "unfinished": .number(Double(unfinished))])
        }
    }
    struct SubagentStat: Equatable {
        var runs = 0, totalMs = 0, toolCalls = 0, model = ""
        var inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0
        var json: JSONValue {
            var o: [String: JSONValue] = ["runs": .number(Double(runs)), "total_ms": .number(Double(totalMs)),
                                          "tool_calls": .number(Double(toolCalls)), "input_tokens": .number(Double(inputTokens)),
                                          "output_tokens": .number(Double(outputTokens)), "cache_read_tokens": .number(Double(cacheReadTokens)),
                                          "cache_write_tokens": .number(Double(cacheWriteTokens))]
            if !model.isEmpty { o["model"] = .string(model) }
            return .object(o)
        }
    }
    private struct Pending { var name: String; var at: Date? }
    private struct Usage { var input = 0, output = 0, cacheRead = 0, cacheWrite = 0, toolErrors = 0 }

    static let maxKeys = 200
    private static let geminiEvents = ["BeforeTool": "PreToolUse", "AfterTool": "PostToolUse", "BeforeAgent": "UserPromptSubmit",
                                       "AfterAgent": "Stop", "PreCompress": "PreCompact", "BeforeModel": "ModelRequest"]
    static let codexToolItems: Set<String> = ["function_call", "custom_tool_call", "local_shell_call", "web_search_call", "tool_search_call"]

    private var firstEvent: Date?, lastEvent: Date?
    private(set) var transcriptPath = ""
    private(set) var events: [String: Int] = [:]
    private(set) var sources: [String: Int] = [:]
    private(set) var tools: [String: ToolStat] = [:]
    private(set) var subagents: [String: SubagentStat] = [:]
    private(set) var compactions: [String: Int] = [:]
    private(set) var notifications: [String: Int] = [:]
    private(set) var stopFailures: [String: Int] = [:]
    private(set) var models: Set<String> = []
    private(set) var prompts = 0
    private(set) var activeMs = 0
    private(set) var maxTurnMs = 0
    private(set) var endReason = ""
    private(set) var costUSD = 0.0

    private var pendingTools: [String: Pending] = [:]
    private var pendingAgents: [String: Pending] = [:]
    private var subagentRuns: [String: String] = [:]
    private var subagentPaths: [String: String] = [:]
    private var turnStart: Date?
    private var usage = Usage()
    private var usageSeen: Set<String> = []
    private var anonCalls: [String: [String]] = [:]
    private var anonSeq = 0
    private var source = "hooks"
    private var ownsTools = false
    private var subagentTokens: [Usage] = []

    private static func bump(_ map: inout [String: Int], _ key: String) {
        guard !key.isEmpty, map[key] != nil || map.count < maxKeys else { return }
        map[key, default: 0] += 1
    }

    private func toolKey(_ name: String) -> String? {
        guard !name.isEmpty, tools[name] != nil || tools.count < Self.maxKeys else { return nil }
        if tools[name] == nil { tools[name] = ToolStat() }
        return name
    }

    private func subagentKey(_ type: String) -> String? {
        guard subagents[type] != nil || subagents.count < Self.maxKeys else { return nil }
        if subagents[type] == nil { subagents[type] = SubagentStat() }
        return type
    }

    // MARK: Hooks (Go: Lifecycle.Hook)

    func hook(_ body: Data, now: Date) {
        guard let decoded = try? JSONDecoder().decode(JSONValue.self, from: body), case .object(let input) = decoded else { return }
        func text(_ key: String) -> String { input[key]?.string ?? "" }
        func int(_ key: String) -> Int { input[key]?.number.map { Int($0) } ?? 0 }
        var event = text("hook_event_name")
        guard !event.isEmpty else { return }
        if let canonical = Self.geminiEvents[event] {
            event = canonical
            if event == "PostToolUse", Self.toolResponseFailed(input["tool_response"]) { event = "PostToolUseFailure" }
        }
        if firstEvent == nil { firstEvent = now }
        lastEvent = now
        Self.bump(&events, event)
        let agentID = text("agent_id"), toolName = text("tool_name"), model = text("model")
        if !text("transcript_path").isEmpty, agentID.isEmpty { transcriptPath = text("transcript_path") }

        switch event {
        case "SessionStart":
            Self.bump(&sources, text("source"))
            if !model.isEmpty { models.insert(model) }
        case "Usage":
            let id = text("message_id")
            guard !id.isEmpty, usageSeen.insert(id).inserted else { break }
            usage.input += int("input_tokens"); usage.output += int("output_tokens")
            usage.cacheRead += int("cache_read_tokens"); usage.cacheWrite += int("cache_write_tokens")
            if let cost = input["cost"]?.number { costUSD += cost }
            if !model.isEmpty { models.insert(model) }
            if !agentID.isEmpty, let type = subagentRuns[agentID], let key = subagentKey(type) {
                subagents[key]!.inputTokens += int("input_tokens"); subagents[key]!.outputTokens += int("output_tokens")
                subagents[key]!.cacheReadTokens += int("cache_read_tokens"); subagents[key]!.cacheWriteTokens += int("cache_write_tokens")
                if !model.isEmpty { subagents[key]!.model = model }
            }
        case "ModelRequest":
            if let requested = input["llm_request"]?["model"]?.string, !requested.isEmpty { models.insert(requested) }
        case "UserPromptSubmit":
            let id = text("message_id")
            if !id.isEmpty, !usageSeen.insert("prompt:" + id).inserted { break }
            prompts += 1
            turnStart = now
        case "Stop":
            if let start = turnStart {
                let ms = Self.ms(now.timeIntervalSince(start))
                activeMs += ms; maxTurnMs = max(maxTurnMs, ms); turnStart = nil
            }
        case "StopFailure":
            Self.bump(&stopFailures, text("error"))
            turnStart = nil
        case "PreToolUse":
            let useID = text("tool_use_id")
            if !useID.isEmpty, !usageSeen.insert("tool:" + useID).inserted { break }
            guard let key = toolKey(toolName) else { break }
            tools[key]!.calls += 1
            if !agentID.isEmpty {
                tools[key]!.subagent += 1
                if let run = subagentRuns[agentID], let sub = subagentKey(run) { subagents[sub]!.toolCalls += 1 }
            }
            var id = useID
            if id.isEmpty {
                anonSeq += 1
                id = "anon-\(anonSeq)"
                anonCalls[toolName, default: []].append(id)
            }
            pendingTools[id] = Pending(name: toolName, at: now)
        case "PostToolUse", "PostToolUseFailure":
            var useID = text("tool_use_id")
            if useID.isEmpty, var queue = anonCalls[toolName], !queue.isEmpty {
                useID = queue.removeFirst(); anonCalls[toolName] = queue
            }
            let pending = pendingTools.removeValue(forKey: useID) ?? Pending(name: toolName, at: nil)
            guard let key = toolKey(pending.name) else { break }
            var ms = -1
            if let duration = input["duration_ms"]?.number { ms = Int(duration) }
            else if let at = pending.at { ms = Self.ms(now.timeIntervalSince(at)) }
            if ms >= 0 { tools[key]!.totalMs += ms; tools[key]!.maxMs = max(tools[key]!.maxMs, ms) }
            if event == "PostToolUseFailure" { tools[key]!.errors += 1 }
        case "PermissionDenied":
            pendingTools.removeValue(forKey: text("tool_use_id"))
            if let key = toolKey(toolName) { tools[key]!.denied += 1 }
        case "SubagentStart":
            let type = text("agent_type").isEmpty ? "unknown" : text("agent_type")
            if !agentID.isEmpty { pendingAgents[agentID] = Pending(name: type, at: now); subagentRuns[agentID] = type }
            if let key = subagentKey(type) { subagents[key]!.runs += 1 }
        case "SubagentStop":
            if !text("agent_transcript_path").isEmpty, !agentID.isEmpty { subagentPaths[agentID] = text("agent_transcript_path") }
            guard let pending = pendingAgents.removeValue(forKey: agentID) else { break }
            if let key = subagentKey(pending.name), let at = pending.at { subagents[key]!.totalMs += Self.ms(now.timeIntervalSince(at)) }
        case "PreCompact":
            Self.bump(&compactions, text("compact_reason").isEmpty ? text("trigger") : text("compact_reason"))
        case "Notification":
            Self.bump(&notifications, text("notification_type"))
        case "PostModelSwitch":
            if !text("to_model").isEmpty { models.insert(text("to_model")) }
        case "SessionEnd":
            endReason = text("reason")
        default:
            break
        }
    }

    /// Whole milliseconds, truncated like Go's Duration.Milliseconds. Rounding to
    /// microseconds first absorbs Double error (0.3 s must not become 299 ms).
    private static func ms(_ interval: TimeInterval) -> Int { Int((interval * 1_000_000).rounded()) / 1000 }

    private static func toolResponseFailed(_ response: JSONValue?) -> Bool {
        guard case .object(let object)? = response, let error = object["error"] else { return false }
        switch error {
        case .null: return false
        case .string(let s): return !s.isEmpty
        default: return true
        }
    }

    // MARK: Report merge (Go: Lifecycle.Merge)

    func merge(into report: inout SessionReport, provider: ProviderKind) {
        if ownsTools || (events["PreToolUse"] ?? 0) > 0 {
            var errors = 0
            for (name, stat) in tools {
                report.tools[name] = max(report.tools[name] ?? 0, stat.calls)
                errors += stat.errors
            }
            if source == "hooks" { report.toolErrors = errors }
        }
        if report.inputTokens + report.outputTokens + report.cacheReadTokens == 0 {
            report.inputTokens = usage.input; report.outputTokens = usage.output
            report.cacheReadTokens = usage.cacheRead; report.cacheWriteTokens = usage.cacheWrite
        }
        for sub in subagentTokens {
            report.inputTokens += sub.input; report.outputTokens += sub.output
            report.cacheReadTokens += sub.cacheRead; report.cacheWriteTokens += sub.cacheWrite
            report.toolErrors += sub.toolErrors
        }
        for (_, pending) in pendingTools { if tools[pending.name] != nil { tools[pending.name]!.unfinished += 1 } }
        pendingTools.removeAll()
        if prompts > report.turns { report.turns = prompts }
        if report.model.isEmpty, let model = models.sorted().first { report.model = model }

        // Subagent transcripts: Claude keeps them beside the main one as <session>/subagents/agent-<id>.jsonl.
        let base = transcriptPath.hasSuffix(".jsonl") ? String(transcriptPath.dropLast(6)) : transcriptPath
        for (id, type) in subagentRuns {
            var path = subagentPaths[id] ?? ""
            if path.isEmpty, !transcriptPath.isEmpty { path = base + "/subagents/agent-" + id + ".jsonl" }
            guard !path.isEmpty else { continue }
            var sub = SessionReport(); sub.provider = report.provider
            SessionReportParser.read(URL(fileURLWithPath: path), provider: provider, into: &sub)
            if subagents[type] != nil {
                subagents[type]!.inputTokens += sub.inputTokens; subagents[type]!.outputTokens += sub.outputTokens
                subagents[type]!.cacheReadTokens += sub.cacheReadTokens; subagents[type]!.cacheWriteTokens += sub.cacheWriteTokens
                if !sub.model.isEmpty { subagents[type]!.model = sub.model }
            }
            report.inputTokens += sub.inputTokens; report.outputTokens += sub.outputTokens
            report.cacheReadTokens += sub.cacheReadTokens; report.cacheWriteTokens += sub.cacheWriteTokens
        }

        func counts(_ map: [String: Int]) -> JSONValue { .object(map.mapValues { .number(Double($0)) }) }
        var span = 0
        if let first = firstEvent, let last = lastEvent { span = Self.ms(last.timeIntervalSince(first)) }
        report.lifecycle = .object([
            "source": .string(source), "events": counts(events), "session_sources": counts(sources),
            "tools": .object(tools.mapValues(\.json)), "subagents": .object(subagents.mapValues(\.json)),
            "compactions": counts(compactions), "notifications": counts(notifications), "stop_failures": counts(stopFailures),
            "models": .array(models.sorted().map(JSONValue.string)), "prompts": .number(Double(prompts)),
            "active_ms": .number(Double(activeMs)), "max_turn_ms": .number(Double(maxTurnMs)),
            "hook_span_ms": .number(Double(span)), "end_reason": .string(endReason), "cost_usd": .number(costUSD),
        ])
    }

    // MARK: Codex rollouts (Go: CodexLifecycle) — Codex has no lifecycle hooks.

    static func codex(path: URL, home: URL, since: Date) -> SessionLifecycle? {
        guard let lines = readLines(path) else { return nil }
        let lifecycle = SessionLifecycle()
        lifecycle.source = "transcript"
        lifecycle.ownsTools = true
        let thread = lifecycle.codexThread(lines, subagent: "")
        guard !thread.isEmpty else { return lifecycle }
        let root = home.appendingPathComponent(".codex/sessions")
        let cutoff = since.addingTimeInterval(-5)
        let keys: [URLResourceKey] = [.contentModificationDateKey, .isRegularFileKey]
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys) else { return lifecycle }
        let mainPath = path.resolvingSymlinksInPath().path
        for case let url as URL in enumerator {
            let name = url.lastPathComponent
            guard name.hasPrefix("rollout-"), name.hasSuffix(".jsonl"), url.resolvingSymlinksInPath().path != mainPath,
                  let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true,
                  let modified = values.contentModificationDate, modified >= cutoff,
                  let meta = codexMeta(url), meta.parent == thread else { continue }
            guard let key = lifecycle.subagentKey(meta.role.isEmpty ? "default" : meta.role), let sub = readLines(url) else { continue }
            lifecycle.subagents[key]!.runs += 1
            let before = lifecycle.activeMs
            _ = lifecycle.codexThread(sub, subagent: key)
            lifecycle.subagents[key]!.totalMs += lifecycle.activeMs - before
            lifecycle.activeMs = before
            var report = SessionReport(); report.provider = "codex"
            SessionReportParser.codex(sub.map { Substring($0) }, into: &report)
            lifecycle.subagents[key]!.inputTokens += report.inputTokens; lifecycle.subagents[key]!.outputTokens += report.outputTokens
            lifecycle.subagents[key]!.cacheReadTokens += report.cacheReadTokens; lifecycle.subagents[key]!.cacheWriteTokens += report.cacheWriteTokens
            if !report.model.isEmpty { lifecycle.subagents[key]!.model = report.model }
            lifecycle.subagentTokens.append(Usage(input: report.inputTokens, output: report.outputTokens, cacheRead: report.cacheReadTokens,
                                                  cacheWrite: report.cacheWriteTokens, toolErrors: report.toolErrors))
        }
        return lifecycle
    }

    private static func codexMeta(_ url: URL) -> (parent: String, role: String)? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: 16 << 20)) ?? Data()
        let first = head.split(separator: UInt8(ascii: "\n"), maxSplits: 1, omittingEmptySubsequences: false).first ?? Data()
        guard let line = try? JSONDecoder().decode(JSONValue.self, from: Data(first)), line["type"]?.string == "session_meta" else { return nil }
        let payload = line["payload"]
        var role = payload?["agent_role"]?.string ?? ""
        if role.isEmpty { role = payload?["source"]?["subagent"]?["thread_spawn"]?["agent_role"]?.string ?? "" }
        return (payload?["parent_thread_id"]?.string ?? "", role)
    }

    /// RFC 3339 with or without fractional seconds (Go: time.RFC3339Nano).
    private static func timestamp(_ text: String) -> Date? {
        guard !text.isEmpty else { return nil }
        return (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: Date.ISO8601FormatStyle()))
    }

    private func codexThread(_ lines: [String], subagent: String) -> String {
        var thread = ""
        var pending: [String: Pending] = [:]
        for line in lines {
            guard let object = try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)) else { continue }
            let stamp = object["timestamp"]?.string ?? ""
            let at = Self.timestamp(stamp)
            if let at {
                if firstEvent == nil || at < firstEvent! { firstEvent = at }
                if lastEvent == nil || at > lastEvent! { lastEvent = at }
            }
            let type = object["type"]?.string ?? "", payload = object["payload"] ?? .null
            let kind = payload["type"]?.string ?? ""
            switch type {
            case "session_meta":
                if thread.isEmpty { thread = payload["id"]?.string ?? "" }
                if subagent.isEmpty { Self.bump(&sources, payload["source"]?.string ?? "") }
            case "turn_context":
                if let model = payload["model"]?.string, !model.isEmpty { models.insert(model) }
            case "response_item" where Self.codexToolItems.contains(kind):
                var name = payload["name"]?.string ?? ""
                if name.isEmpty { name = kind == "local_shell_call" ? "shell" : kind }
                guard let key = toolKey(name) else { break }
                tools[key]!.calls += 1
                if !subagent.isEmpty {
                    tools[key]!.subagent += 1
                    if let sub = subagentKey(subagent) { subagents[sub]!.toolCalls += 1 }
                }
                if let id = payload["call_id"]?.string, !id.isEmpty, let at { pending[id] = Pending(name: name, at: at) }
            case "response_item" where kind.hasSuffix("_output"):
                guard let id = payload["call_id"]?.string, let call = pending.removeValue(forKey: id) else { break }
                if tools[call.name] != nil, let at, let start = call.at {
                    let ms = Self.ms(at.timeIntervalSince(start))
                    tools[call.name]!.totalMs += ms; tools[call.name]!.maxMs = max(tools[call.name]!.maxMs, ms)
                }
            case "event_msg" where kind == "task_started":
                if subagent.isEmpty { prompts += 1 }
            case "event_msg" where kind == "task_complete":
                let ms = payload["duration_ms"]?.number.map { Int($0) } ?? 0
                activeMs += ms
                if subagent.isEmpty { maxTurnMs = max(maxTurnMs, ms) }
                Self.bump(&events, "TurnComplete")
            case "event_msg" where kind == "turn_aborted":
                let reason = payload["reason"]?.string ?? ""
                Self.bump(&stopFailures, reason.isEmpty ? "aborted" : reason)
            case "compacted":
                Self.bump(&compactions, "auto")
            default:
                break
            }
        }
        for (_, call) in pending where tools[call.name] != nil { tools[call.name]!.unfinished += 1 }
        return thread
    }

    private static func readLines(_ url: URL) -> [String]? {
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 200 << 20,
              let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

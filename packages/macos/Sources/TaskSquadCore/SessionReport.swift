import CryptoKit
import Foundation

/// Aggregate usage for one session, posted to POST /daemon/session/metrics.
/// Counts only: tool and skill names, token totals, turns, duration, model —
/// never prompt or message content.
public struct SessionReport: Equatable, Sendable {
    public var provider = ""
    public var model = ""
    public var durationMs = 0
    public var turns = 0
    public var inputTokens = 0
    public var outputTokens = 0
    public var cacheReadTokens = 0
    public var cacheWriteTokens = 0
    public var toolErrors = 0
    public var tools: [String: Int] = [:]
    public var skills: [String: Int] = [:]
    public var toolCalls: Int { tools.values.reduce(0, +) }

    public var json: JSONValue {
        func counts(_ map: [String: Int]) -> JSONValue { .object(map.mapValues { .number(Double($0)) }) }
        return .object([
            "provider": .string(provider), "model": .string(model),
            "duration_ms": .number(Double(durationMs)), "turns": .number(Double(turns)),
            "tokens": .object(["input": .number(Double(inputTokens)), "output": .number(Double(outputTokens)),
                               "cache_read": .number(Double(cacheReadTokens)), "cache_write": .number(Double(cacheWriteTokens))]),
            "tool_calls": .number(Double(toolCalls)), "tool_errors": .number(Double(toolErrors)),
            "tools": counts(tools), "skills": counts(skills),
        ])
    }

    mutating func addTool(_ name: String) { if !name.isEmpty { tools[name, default: 0] += 1 } }
    mutating func addSkill(_ name: String) { if !name.isEmpty { skills[name, default: 0] += 1 } }
}

public enum SessionReportParser {
    private static let skillToken = try! NSRegularExpression(pattern: #"(?:^|\s)[/$](tsq-[A-Za-z0-9_-]+)"#)

    /// TaskSquad skill invocations (`/tsq-x`, or `$tsq-x` for Codex) in text the engine typed.
    public static func skills(in text: String) -> [String] {
        skillToken.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
            Range($0.range(at: 1), in: text).map { String(text[$0]) }
        }
    }

    // MARK: Claude Code — ~/.claude/projects/<dir>/<session>.jsonl

    /// Streaming writes each assistant message several times; usage is counted once per message id.
    public static func claude(_ lines: some Sequence<Substring>, into report: inout SessionReport) {
        var seenUsage = Set<String>(), seenTools = Set<String>()
        for line in lines {
            guard let object = parse(line), let message = object["message"] else { continue }
            if let model = message["model"]?.string, !model.isEmpty, !model.hasPrefix("<") { report.model = model }
            let messageID = message["id"]?.string ?? UUID().uuidString
            if let usage = message["usage"], seenUsage.insert(messageID).inserted {
                report.inputTokens += int(usage["input_tokens"])
                report.outputTokens += int(usage["output_tokens"])
                report.cacheReadTokens += int(usage["cache_read_input_tokens"])
                report.cacheWriteTokens += int(usage["cache_creation_input_tokens"])
            }
            for block in message["content"]?.array ?? [] {
                switch block["type"]?.string {
                case "tool_use":
                    guard seenTools.insert(block["id"]?.string ?? UUID().uuidString).inserted, let name = block["name"]?.string else { continue }
                    report.addTool(name)
                    if name == "Skill", let skill = block["input"]?["skill"]?.string ?? block["input"]?["name"]?.string { report.addSkill(skill) }
                case "tool_result":
                    if block["is_error"] == .bool(true) { report.toolErrors += 1 }
                default: continue
                }
            }
        }
    }

    // MARK: Codex — ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl

    public static func codex(_ lines: some Sequence<Substring>, into report: inout SessionReport) {
        var lastTotals: JSONValue?
        for line in lines {
            guard let object = parse(line) else { continue }
            let payload = object["payload"] ?? .null
            switch (object["type"]?.string, payload["type"]?.string) {
            case ("turn_context", _):
                if let model = payload["model"]?.string, !model.isEmpty { report.model = model }
            case ("response_item", let kind?) where ["function_call", "custom_tool_call", "local_shell_call", "web_search_call", "tool_search_call"].contains(kind):
                report.addTool(payload["name"]?.string ?? (kind == "local_shell_call" ? "shell" : kind))
            case ("event_msg", "token_count"):
                // Cumulative for the thread; the last one wins.
                if let totals = payload["info"]?["total_token_usage"] { lastTotals = totals }
            case ("event_msg", "item_completed"):
                if payload["item"]?["status"]?.string == "failed" { report.toolErrors += 1 }
            default: continue
            }
        }
        if let totals = lastTotals {
            let cached = int(totals["cached_input_tokens"])
            report.inputTokens = max(int(totals["input_tokens"]) - cached, 0)
            report.cacheReadTokens = cached
            report.cacheWriteTokens = int(totals["cache_write_input_tokens"])
            report.outputTokens = int(totals["output_tokens"]) + int(totals["reasoning_output_tokens"])
        }
    }

    // MARK: Gemini, Pi and other JSON/JSONL transcripts

    /// Format-agnostic scan: tool calls are objects with a tool-ish `type` (or a
    /// `functionCall`/`toolCall`) and a name; token counts use the common key names.
    public static func generic(_ value: JSONValue, into report: inout SessionReport) {
        switch value {
        case .array(let items): items.forEach { generic($0, into: &report) }
        case .object(let object):
            let type = object["type"]?.string ?? ""
            if ["tool_use", "tool_call", "toolCall", "function_call", "tool-call"].contains(type), let name = object["name"]?.string ?? object["toolName"]?.string {
                report.addTool(name)
            }
            if let call = object["functionCall"] ?? object["toolCall"], let name = call["name"]?.string { report.addTool(name) }
            if let model = object["model"]?.string ?? object["modelId"]?.string, !model.isEmpty, report.model.isEmpty { report.model = model }
            let tokenish = object["usage"] ?? object["usageMetadata"] ?? object["tokens"]
            if let usage = tokenish, case .object = usage {
                report.inputTokens += int(usage["input_tokens"]) + int(usage["input"]) + int(usage["promptTokenCount"]) + int(usage["prompt_tokens"])
                report.outputTokens += int(usage["output_tokens"]) + int(usage["output"]) + int(usage["candidatesTokenCount"]) + int(usage["completion_tokens"])
                report.cacheReadTokens += int(usage["cache_read_input_tokens"]) + int(usage["cacheRead"]) + int(usage["cachedContentTokenCount"])
            }
            for (key, child) in object where !["usage", "usageMetadata", "tokens"].contains(key) { generic(child, into: &report) }
        default: return
        }
    }

    // MARK: Locating transcripts

    /// Best-effort transcript for a session; nil when the harness keeps none we know.
    public static func transcript(provider: ProviderKind, workDir: String, hookTranscript: String, codexThread: String,
                                  since: Date, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL? {
        let fm = FileManager.default
        if !hookTranscript.isEmpty, fm.fileExists(atPath: hookTranscript) { return URL(fileURLWithPath: hookTranscript) }
        func newest(in directory: URL, recursive: Bool = false, matching: (URL) -> Bool) -> URL? {
            let keys: [URLResourceKey] = [.contentModificationDateKey]
            let urls: [URL]
            if recursive {
                urls = (fm.enumerator(at: directory, includingPropertiesForKeys: keys)?.compactMap { $0 as? URL }) ?? []
            } else { urls = (try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)) ?? [] }
            return urls.filter(matching)
                .compactMap { url in (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate).map { (url, $0) } }
                .filter { $0.1 >= since.addingTimeInterval(-5) }
                .max { $0.1 < $1.1 }?.0
        }
        switch provider {
        case .codex:
            guard !codexThread.isEmpty else { return nil }
            return newest(in: home.appendingPathComponent(".codex/sessions"), recursive: true) {
                $0.lastPathComponent.hasPrefix("rollout-") && $0.lastPathComponent.hasSuffix("\(codexThread).jsonl")
            }
        case .pi:
            let folder = "--" + workDir.trimmingCharacters(in: CharacterSet(charactersIn: "/")).replacingOccurrences(of: "/", with: "-") + "--"
            return newest(in: home.appendingPathComponent(".pi/agent/sessions/\(folder)")) { $0.pathExtension == "jsonl" }
        case .gemini:
            let hash = SHA256.hash(data: Data(workDir.utf8)).map { String(format: "%02x", $0) }.joined()
            return newest(in: home.appendingPathComponent(".gemini/tmp/\(hash)"), recursive: true) { ["json", "jsonl"].contains($0.pathExtension) }
        default: return nil
        }
    }

    /// Parses the transcript (if any) for the provider into `report`.
    public static func read(_ url: URL, provider: ProviderKind, into report: inout SessionReport) {
        // Bound memory on very long sessions: transcripts can reach hundreds of MB.
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size < 200 * 1024 * 1024,
              let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        switch provider {
        case .claudeCode: claude(lines, into: &report)
        case .codex: codex(lines, into: &report)
        default:
            if url.pathExtension == "jsonl" { lines.compactMap(parse).forEach { generic($0, into: &report) } }
            else if let value = parse(Substring(text)) { generic(value, into: &report) }
        }
    }

    private static func parse(_ line: Substring) -> JSONValue? { try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)) }
    private static func int(_ value: JSONValue?) -> Int { value?.number.map { Int($0) } ?? 0 }
}

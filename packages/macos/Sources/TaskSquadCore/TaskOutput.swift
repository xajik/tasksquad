import Foundation

public enum TaskPrompt {
    public static func build(subject: String, messages: [JSONValue], memoryRollup: String = "") -> String {
        let base: String
        if messages.isEmpty { base = subject }
        else if messages.count == 1 { base = messages[0]["body"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? subject }
        else {
            base = messages.compactMap { message -> String? in
                switch message["role"]?.string {
                case "user": return "Human: " + (message["body"]?.string ?? "") + "\n\n"
                case "agent": return "Assistant: " + (message["body"]?.string ?? "") + "\n\n"
                default: return nil
                }
            }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return memoryRollup.isEmpty ? base : "## Project memory (recent activity)\n\(memoryRollup)\n\n---\n\n\(base)"
    }
}

public struct TaskOutput: Sendable {
    private var pending = Data()
    public private(set) var lines: [String] = []
    private let limit = 4 * 1024 * 1024
    public init() { }

    public mutating func append(_ chunk: Data) throws -> [String] {
        pending.append(chunk)
        var newLines: [String] = []
        while let newline = pending.firstIndex(of: 10) {
            let bytes = pending[..<newline]
            guard bytes.count < limit else { throw ConfigurationError("Process output line exceeds 4 MiB") }
            record(bytes, into: &newLines)
            pending.removeSubrange(...newline)
        }
        guard pending.count < limit else { throw ConfigurationError("Process output line exceeds 4 MiB") }
        return newLines
    }
    public mutating func finish() -> [String] {
        var result: [String] = []
        if !pending.isEmpty { record(pending[...], into: &result); pending.removeAll() }
        return result
    }
    private mutating func record(_ data: Data.SubSequence, into newLines: inout [String]) {
        // bufio.ScanLines drops one CR immediately preceding the newline/EOF.
        let bytes = data.last == 13 ? data.dropLast() : data[...]
        let cleaned = Self.cleanLine(String(decoding: bytes, as: UTF8.self))
        if !cleaned.isEmpty { lines.append(cleaned); newLines.append(cleaned) }
    }
    public var logContent: String { lines.joined(separator: "\n") }
    public var finalText: String {
        let value = logContent.trimmingCharacters(in: .whitespacesAndNewlines)
        // Go limits by bytes, including replacement decoding if the cut crosses UTF-8.
        return String(decoding: value.utf8.suffix(10_000), as: UTF8.self)
    }
    private static let ansiEscapeRegex = try! NSRegularExpression(pattern: "\u{1b}(\\[[0-9;?]*[A-Za-z]|\\][^\u{7}]*(\u{7}|\u{1b}\\\\)|\\(B|[0-9A-Za-z])")
    public static func cleanLine(_ line: String) -> String {
        let visible = line.lastIndex(of: "\r").map { String(line[line.index(after: $0)...]) } ?? line
        var value = ansiEscapeRegex.stringByReplacingMatches(in: visible, range: NSRange(visible.startIndex..., in: visible), withTemplate: "")
        while value.last == " " || value.last == "\t" { value.removeLast() }
        return value
    }
}

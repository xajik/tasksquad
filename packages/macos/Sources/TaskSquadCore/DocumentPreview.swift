import Foundation

public struct PreviewDocument: Sendable {
    public let url: URL
    public let text: String
    public let notice: String?
    public var isMarkdown: Bool { ["md", "markdown"].contains(url.pathExtension.lowercased()) }
    public var isJSON: Bool { ["json", "jsonl", "ndjson"].contains(url.pathExtension.lowercased()) }

    public static func load(_ url: URL, limit: Int = 2 * 1024 * 1024) throws -> Self {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let size = try handle.seekToEnd()
        let tail = ["log", "jsonl", "ndjson"].contains(url.pathExtension.lowercased())
        let truncated = size > UInt64(limit)
        try handle.seek(toOffset: truncated && tail ? size - UInt64(limit) : 0)
        var data = try handle.read(upToCount: limit) ?? Data()
        if truncated && tail, let newline = data.firstIndex(of: 10) { data = data.suffix(from: data.index(after: newline)) }
        return Self(url: url, text: String(decoding: data, as: UTF8.self), notice: truncated
            ? "Preview limited to the \(tail ? "last" : "first") \(limit / 1024) KiB. Open in your editor to read the complete file." : nil)
    }
}

/// Lossless JSON presentation: keep number lexemes, ordering and duplicate keys.
/// Do not round identifiers through JSONValue's Double representation.
public struct JSONPreviewNode: Identifiable, Sendable, Equatable {
    public enum Kind: String, Sendable { case object, array, string, number, boolean, null, invalid }
    public let id: String
    public let label: String
    public let kind: Kind
    public let value: String
    public let raw: String
    public let children: [JSONPreviewNode]
    public var isContainer: Bool { kind == .object || kind == .array }

    public static func parse(_ source: String, lines: Bool = false) throws -> [Self] {
        if lines {
            return source.split(separator: "\n", omittingEmptySubsequences: false).enumerated().compactMap { index, line in
                guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                do { var parser = Parser(String(line)); return try parser.parse(id: "\(index)", label: "Record \(index + 1)") }
                catch { return Self(id: "\(index)", label: "Record \(index + 1)", kind: .invalid, value: error.localizedDescription, raw: String(line), children: []) }
            }
        }
        var parser = Parser(source)
        return [try parser.parse(id: "root", label: "Document")]
    }

    private struct Parser {
        let bytes: [UInt8]
        var index = 0
        var nodes = 0
        init(_ source: String) { bytes = Array(source.utf8) }
        mutating func whitespace() { while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 } }
        mutating func parse(id: String, label: String) throws -> JSONPreviewNode {
            let node = try value(id: id, label: label, depth: 0)
            whitespace()
            guard index == bytes.count else { throw error("Unexpected content") }
            return node
        }
        func error(_ reason: String) -> ConfigurationError { ConfigurationError("\(reason) at byte \(index + 1)") }
        mutating func string() throws -> String {
            let start = index
            guard index < bytes.count && bytes[index] == 34 else { throw error("Expected a quoted string") }
            index += 1
            var escaped = false
            while index < bytes.count {
                let byte = bytes[index]; index += 1
                if byte == 34 && !escaped {
                    let data = Data(bytes[start..<index])
                    guard let decoded = try? JSONDecoder().decode(String.self, from: data) else { throw error("Invalid string escape") }
                    return decoded
                }
                if byte < 32 { throw error("Control character in string") }
                if byte == 92 && !escaped { escaped = true } else { escaped = false }
            }
            throw error("Unterminated string")
        }
        mutating func value(id: String, label: String, depth: Int) throws -> JSONPreviewNode {
            nodes += 1
            guard depth < 128, nodes <= 100_000 else { throw error("Document exceeds preview complexity limit") }
            whitespace()
            let start = index
            guard index < bytes.count else { throw error("Expected a value") }
            var children: [JSONPreviewNode] = []
            let kind: Kind, text: String
            switch bytes[index] {
            case 123, 91:
                let object = bytes[index] == 123
                kind = object ? .object : .array
                let end: UInt8 = object ? 125 : 93
                index += 1; whitespace()
                if index < bytes.count && bytes[index] == end { index += 1 }
                else {
                    while true {
                        whitespace()
                        let childLabel = object ? try string() : "[\(children.count)]"
                        if object {
                            whitespace()
                            guard index < bytes.count && bytes[index] == 58 else { throw error("Expected a colon") }
                            index += 1
                        }
                        children.append(try value(id: id + "/\(children.count)", label: childLabel, depth: depth + 1))
                        whitespace()
                        guard index < bytes.count else { throw error("Unclosed container") }
                        if bytes[index] == end { index += 1; break }
                        guard bytes[index] == 44 else { throw error("Expected a comma") }
                        index += 1
                    }
                }
                text = "\(children.count) \(object ? "fields" : "items")"
            case 34: kind = .string; text = try string()
            default:
                while index < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[index]) { index += 1 }
                let token = String(decoding: bytes[start..<index], as: UTF8.self)
                switch token {
                case "true", "false": kind = .boolean
                case "null": kind = .null
                default:
                    guard token.range(of: #"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$"#, options: .regularExpression) != nil else { throw error("Invalid JSON value") }
                    kind = .number
                }
                text = token
            }
            return JSONPreviewNode(id: id, label: label, kind: kind, value: text,
                                   raw: String(decoding: bytes[start..<index], as: UTF8.self), children: children)
        }
    }
}

public struct MarkdownBlock: Identifiable, Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case heading(Int), paragraph, code(String), quote, list(String, Int), task(Bool, Int), rule, table
    }
    public let id: Int
    public let kind: Kind
    public let text: String
    public let rows: [[String]]

    public static func parse(_ source: String) -> [Self] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var result: [Self] = [], paragraph: [String] = []
        func add(_ kind: Kind, _ text: String = "", rows: [[String]] = []) { result.append(Self(id: result.count, kind: kind, text: text, rows: rows)) }
        func flush() { if !paragraph.isEmpty { add(.paragraph, paragraph.joined(separator: "\n")); paragraph.removeAll() } }
        func cells(_ line: String) -> [String] {
            var value = line.trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("|") { value.removeFirst() }; if value.hasSuffix("|") { value.removeLast() }
            return value.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        var i = 0
        while i < lines.count {
            let line = lines[i], trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flush(); i += 1; continue }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let marker = trimmed.first!, count = trimmed.prefix(while: { $0 == marker }).count
                let language = String(trimmed.dropFirst(count)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []; i += 1
                while i < lines.count {
                    let closing = lines[i].trimmingCharacters(in: .whitespaces)
                    if closing.prefix(while: { $0 == marker }).count >= count && closing.allSatisfy({ $0 == marker }) { break }
                    code.append(lines[i]); i += 1
                }
                add(.code(language), code.joined(separator: "\n")); i += 1; continue
            }
            let hashes = trimmed.prefix(while: { $0 == "#" }).count
            if (1...6).contains(hashes), trimmed.dropFirst(hashes).first == " " {
                flush(); add(.heading(hashes), String(trimmed.dropFirst(hashes + 1))); i += 1; continue
            }
            if i + 1 < lines.count {
                let next = lines[i + 1].trimmingCharacters(in: .whitespaces)
                if !next.isEmpty && (next.allSatisfy({ $0 == "=" }) || next.allSatisfy({ $0 == "-" })) {
                    flush(); add(.heading(next.first == "=" ? 1 : 2), trimmed); i += 2; continue
                }
                let separators = cells(next)
                // GFM only requires >=1 hyphen per delimiter cell (e.g. "|-|-|" is valid).
                if trimmed.contains("|"), separators.count > 1,
                   separators.allSatisfy({ !$0.isEmpty && $0.contains("-") && $0.allSatisfy({ $0 == "-" || $0 == ":" }) }) {
                    flush(); var rows = [cells(trimmed)]; i += 2
                    while i < lines.count && lines[i].contains("|") && !lines[i].isEmpty { rows.append(cells(lines[i])); i += 1 }
                    add(.table, rows: rows); continue
                }
            }
            let compact = trimmed.filter { !$0.isWhitespace }
            if compact.count >= 3 && ["-", "*", "_"].contains(String(compact.first!)) && compact.allSatisfy({ $0 == compact.first! }) {
                flush(); add(.rule); i += 1; continue
            }
            if trimmed.hasPrefix(">") {
                flush(); var quote: [String] = []
                while i < lines.count && lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    quote.append(String(lines[i].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .whitespaces)); i += 1
                }
                add(.quote, quote.joined(separator: "\n")); continue
            }
            let indent = min(8, line.prefix(while: { $0 == " " }).count / 2)
            if let range = trimmed.range(of: #"^([-+*]|[0-9]+[.)])\s+"#, options: .regularExpression) {
                flush(); let marker = trimmed[range].trimmingCharacters(in: .whitespaces)
                let content = String(trimmed[range.upperBound...])
                if content.hasPrefix("[ ] ") || content.lowercased().hasPrefix("[x] ") {
                    add(.task(content.lowercased().hasPrefix("[x] "), indent), String(content.dropFirst(4)))
                } else { add(.list(["-", "+", "*"].contains(marker) ? "•" : marker, indent), content) }
                i += 1; continue
            }
            paragraph.append(line); i += 1
        }
        flush(); return result
    }
}

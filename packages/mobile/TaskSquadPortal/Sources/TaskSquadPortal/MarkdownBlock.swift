import Foundation

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

import Foundation

// A native Swift parser, with no process or runtime dependencies. It retains unknown
// values so old/new configuration keys can coexist. Configuration edits preserve the
// original document rather than serializing this representation over user comments.
indirect enum TOMLValue: Equatable {
    case string(String), integer(Int64), float(Double), bool(Bool)
    case array([TOMLValue]), table([String: TOMLValue]), date(String)
}

struct TOMLDocument {
    private(set) var root: [String: TOMLValue] = [:]

    init(_ source: String) throws {
        var parser = TOMLParser(source)
        root = try parser.parse()
    }
}

struct TOMLError: LocalizedError {
    let line: Int
    let message: String
    var errorDescription: String? { "TOML line \(line): \(message)" }
}

private struct TOMLParser {
    private let chars: [Unicode.Scalar]
    private var index = 0
    private var line = 1
    private var root: [String: TOMLValue] = [:]
    private var context: [String] = []
    private var explicitTables = Set<[String]>()
    private var assignedValues = Set<[String]>()
    private var arrayTables = Set<[String]>()

    init(_ source: String) { chars = Array(source.unicodeScalars) }
    private var current: Unicode.Scalar? { index < chars.count ? chars[index] : nil }
    private func at(_ offset: Int) -> Unicode.Scalar? {
        index + offset < chars.count ? chars[index + offset] : nil
    }
    private mutating func advance() {
        if current == "\n" { line += 1 }
        index += 1
    }
    private func error(_ message: String) -> TOMLError { TOMLError(line: line, message: message) }
    private mutating func expect(_ char: Unicode.Scalar) throws {
        guard current == char else { throw error("expected '\(char)'") }
        advance()
    }
    private mutating func whitespace(newlines: Bool = false) {
        while let c = current {
            if c == " " || c == "\t" || (newlines && (c == "\n" || c == "\r")) { advance() }
            else if c == "#" && newlines { skipComment() }
            else { break }
        }
    }
    private mutating func skipComment() {
        while let c = current, c != "\n", c != "\r" { advance() }
    }
    private mutating func endLine() throws {
        whitespace()
        if current == "#" { skipComment() }
        if current == "\r" { advance(); try expect("\n") }
        else if current == "\n" { advance() }
        else if current != nil { throw error("unexpected characters after value") }
    }

    mutating func parse() throws -> [String: TOMLValue] {
        while true {
            whitespace(newlines: true)
            guard current != nil else { return root }
            if current == "[" {
                advance()
                let isArray = current == "["
                if isArray { advance() }
                let path = try keyPath()
                try expect("]")
                if isArray { try expect("]") }
                try endLine()
                // A table within an array belongs to its newest element. The table
                // identity includes array indices so repeated [[agents]] are distinct.
                let identity = resolvedIdentity(path, in: root)
                let collectionIdentity = resolvedIdentity(Array(path.dropLast()), in: root) + [path.last!]
                if assignedValues.contains(where: { collectionIdentity.starts(with: $0) }) {
                    throw error("table redefines an existing value")
                }
                if !isArray && !explicitTables.insert(identity).inserted {
                    throw error("duplicate table \(path.joined(separator: "."))")
                }
                let isDeclaredArray = arrayTables.contains(collectionIdentity)
                var updated = root
                try modifyTable(&updated, path: path[...]) { table, key in
                    if isArray {
                        if let existing = table[key] {
                            guard isDeclaredArray, case .array(var entries) = existing,
                                  entries.allSatisfy({ if case .table = $0 { return true }; return false })
                            else { throw error("table conflicts with existing value") }
                            entries.append(.table([:]))
                            table[key] = .array(entries)
                        } else { table[key] = .array([.table([:])]) }
                    } else if let existing = table[key] {
                        guard case .table = existing else { throw error("table conflicts with existing value") }
                    } else { table[key] = .table([:]) }
                }
                root = updated
                if isArray { arrayTables.insert(collectionIdentity) }
                context = path
            } else {
                let key = try keyPath()
                try expect("=")
                whitespace()
                let value = try value()
                try endLine()
                let contextIdentity = resolvedIdentity(context, in: root)
                let identity = contextIdentity + key
                if assignedValues.contains(where: { identity.starts(with: $0) }) {
                    throw error("key extends or redefines an existing value")
                }
                var updated = root
                try insert(value, at: context + key, in: &updated)
                root = updated
                assignedValues.insert(identity)
            }
        }
    }

    private func resolvedIdentity(_ path: [String], in table: [String: TOMLValue]) -> [String] {
        guard let key = path.first else { return [] }
        let rest = Array(path.dropFirst())
        switch table[key] {
        case .table(let child): return [key] + resolvedIdentity(rest, in: child)
        case .array(let entries):
            if case .table(let child) = entries.last {
                return [key, "[\(entries.count - 1)]"] + resolvedIdentity(rest, in: child)
            }
            fallthrough
        default: return path
        }
    }

    private func modifyTable(_ table: inout [String: TOMLValue], path: ArraySlice<String>,
                             action: (inout [String: TOMLValue], String) throws -> Void) throws {
        guard let key = path.first else { throw error("empty key") }
        if path.count == 1 { try action(&table, key); return }
        switch table[key] {
        case .none, .table:
            var child: [String: TOMLValue] = [:]
            if case .table(let value) = table[key] { child = value }
            try modifyTable(&child, path: path.dropFirst(), action: action)
            table[key] = .table(child)
        case .array(var entries):
            guard case .table(var child) = entries.last else { throw error("not an array of tables") }
            try modifyTable(&child, path: path.dropFirst(), action: action)
            entries[entries.count - 1] = .table(child)
            table[key] = .array(entries)
        default: throw error("key \(key) is already a scalar")
        }
    }

    private func insert(_ value: TOMLValue, at path: [String], in table: inout [String: TOMLValue]) throws {
        try modifyTable(&table, path: path[...]) { target, key in
            guard target[key] == nil else { throw error("duplicate key \(key)") }
            target[key] = value
        }
    }

    private mutating func keyPath() throws -> [String] {
        var keys: [String] = []
        while true {
            whitespace()
            if current == "\"" || current == "'" {
                keys.append(try string(allowMultiline: false))
            } else {
                var key = ""
                while let c = current, c.isASCII,
                      CharacterSet.alphanumerics.contains(c) || c == "_" || c == "-" {
                    key.unicodeScalars.append(c)
                    advance()
                }
                guard !key.isEmpty else { throw error("expected key") }
                keys.append(key)
            }
            whitespace()
            guard current == "." else { return keys }
            advance()
        }
    }

    private mutating func string(allowMultiline: Bool = true) throws -> String {
        guard let quote = current else { throw error("expected string") }
        advance()
        let multiline = allowMultiline && current == quote && at(1) == quote
        if multiline {
            advance(); advance()
            if current == "\r" { advance(); try expect("\n") }
            else if current == "\n" { advance() }
        }
        var result = ""
        while let c = current {
            if c == quote {
                if !multiline { advance(); return result }
                if at(1) == quote && at(2) == quote {
                    advance(); advance(); advance()
                    // TOML permits one or two quotes just before a triple terminator.
                    for _ in 0..<2 where current == quote { result.unicodeScalars.append(quote); advance() }
                    return result
                }
            }
            if c == "\\" && quote == "\"" {
                advance()
                if multiline && (current == "\n" || current == "\r" || current == " " || current == "\t") {
                    whitespace()
                    guard current == "\n" || current == "\r" else { throw error("invalid continuation") }
                    while current == "\n" || current == "\r" || current == " " || current == "\t" { advance() }
                    continue
                }
                guard let escaped = current else { throw error("unfinished escape") }
                advance()
                switch escaped {
                case "b": result.append("\u{8}")
                case "t": result.append("\t")
                case "n": result.append("\n")
                case "f": result.append("\u{c}")
                case "r": result.append("\r")
                case "\"": result.append("\"")
                case "\\": result.append("\\")
                case "u", "U":
                    var hex = ""
                    for _ in 0..<(escaped == "u" ? 4 : 8) {
                        guard let digit = current, CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains(digit)
                        else { throw error("invalid Unicode escape") }
                        hex.unicodeScalars.append(digit); advance()
                    }
                    guard let number = UInt32(hex, radix: 16), let scalar = Unicode.Scalar(number)
                    else { throw error("invalid Unicode scalar") }
                    result.unicodeScalars.append(scalar)
                default: throw error("invalid string escape")
                }
                continue
            }
            if c == "\r" && multiline { advance(); try expect("\n"); result.append("\n"); continue }
            if c == "\n" && multiline { result.append("\n"); advance(); continue }
            guard c.value >= 0x20 || c == "\t", c.value != 0x7f else { throw error("control character in string") }
            result.unicodeScalars.append(c)
            advance()
        }
        throw error("unterminated string")
    }

    private mutating func value() throws -> TOMLValue {
        if current == "\"" || current == "'" { return .string(try string()) }
        if current == "[" {
            advance()
            var entries: [TOMLValue] = []
            whitespace(newlines: true)
            while current != "]" {
                entries.append(try value())
                whitespace(newlines: true)
                if current != "," { break }
                advance(); whitespace(newlines: true)
            }
            try expect("]")
            return .array(entries)
        }
        if current == "{" {
            advance(); whitespace()
            var table: [String: TOMLValue] = [:]
            var assigned = Set<[String]>()
            while current != "}" {
                let path = try keyPath()
                guard !assigned.contains(where: { path.starts(with: $0) }) else { throw error("inline table extends existing value") }
                try expect("="); whitespace()
                let item = try value()
                try insert(item, at: path, in: &table)
                assigned.insert(path)
                whitespace()
                if current != "," { break }
                advance(); whitespace()
                guard current != "}" else { throw error("trailing comma in inline table") }
            }
            try expect("}")
            return .table(table)
        }
        var token = ""
        while let c = current, !["\n", "\r", "#", ",", "]", "}"].contains(c) {
            token.unicodeScalars.append(c); advance()
        }
        token = token.trimmingCharacters(in: .whitespaces)
        if token == "true" { return .bool(true) }
        if token == "false" { return .bool(false) }
        func matches(_ pattern: String) -> Bool { token.range(of: pattern, options: .regularExpression) != nil }
        if matches(#"^[+-]?(0|[1-9](?:_?[0-9])*)$"#), let n = Int64(token.replacingOccurrences(of: "_", with: "")) {
            return .integer(n)
        }
        for (prefix, digits, radix) in [("0x", "0-9a-fA-F", 16), ("0o", "0-7", 8), ("0b", "01", 2)] {
            if matches("^" + prefix + "[" + digits + "](?:_?[" + digits + "])*$"),
               let n = Int64(token.dropFirst(2).replacingOccurrences(of: "_", with: ""), radix: radix) { return .integer(n) }
        }
        if ["inf", "+inf", "-inf", "nan", "+nan", "-nan"].contains(token) {
            return .float(token.contains("nan") ? .nan : (token == "-inf" ? -.infinity : .infinity))
        }
        if matches(#"^[+-]?(0|[1-9](?:_?[0-9])*)(\.[0-9](?:_?[0-9])*)?([eE][+-]?[0-9](?:_?[0-9])*)?$"#),
           token.contains(".") || token.lowercased().contains("e"),
           let n = Double(token.replacingOccurrences(of: "_", with: "")) { return .float(n) }
        if matches(#"^(\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(\.\d+)?)$"#) {
            return .date(token)
        }
        throw error("invalid value '\(token)'")
    }
}

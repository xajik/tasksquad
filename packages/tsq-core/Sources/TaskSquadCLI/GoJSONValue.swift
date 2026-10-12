import Foundation

/// JSON as Go's encoding/json sees it with Decoder.UseNumber: numbers keep their
/// literal text, and encoding sorts keys, escapes <>&, U+2028/9 and control
/// characters, and indents like json.Encoder.SetIndent("", "  ").
indirect enum GoJSONValue: Equatable {
    case object([String: GoJSONValue]), array([GoJSONValue]), string(String), number(String), bool(Bool), null

    subscript(key: String) -> GoJSONValue? { if case .object(let o) = self { o[key] } else { nil } }
    var string: String? { if case .string(let s) = self { s } else { nil } }
    var array: [GoJSONValue]? { if case .array(let a) = self { a } else { nil } }
    var number: Double? { if case .number(let n) = self { Double(n) } else { nil } }

    // MARK: Parsing

    struct ParseError: Error {}

    static func parse(_ data: Data) throws -> GoJSONValue {
        var parser = Parser(bytes: Array(data))
        parser.skipSpace()
        let value = try parser.value()
        parser.skipSpace()
        return value
    }

    private struct Parser {
        let bytes: [UInt8]
        var i = 0
        mutating func skipSpace() { while i < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[i]) { i += 1 } }
        mutating func expect(_ literal: String) throws {
            let l = Array(literal.utf8)
            guard i + l.count <= bytes.count, Array(bytes[i..<(i + l.count)]) == l else { throw ParseError() }
            i += l.count
        }
        mutating func value() throws -> GoJSONValue {
            guard i < bytes.count else { throw ParseError() }
            switch bytes[i] {
            case UInt8(ascii: "{"):
                i += 1; skipSpace()
                var object: [String: GoJSONValue] = [:]
                if i < bytes.count, bytes[i] == UInt8(ascii: "}") { i += 1; return .object(object) }
                while true {
                    skipSpace()
                    guard case .string(let key) = try value() else { throw ParseError() }
                    skipSpace(); try expect(":"); skipSpace()
                    object[key] = try value()
                    skipSpace()
                    guard i < bytes.count else { throw ParseError() }
                    if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                    if bytes[i] == UInt8(ascii: "}") { i += 1; return .object(object) }
                    throw ParseError()
                }
            case UInt8(ascii: "["):
                i += 1; skipSpace()
                var array: [GoJSONValue] = []
                if i < bytes.count, bytes[i] == UInt8(ascii: "]") { i += 1; return .array(array) }
                while true {
                    skipSpace(); array.append(try value()); skipSpace()
                    guard i < bytes.count else { throw ParseError() }
                    if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
                    if bytes[i] == UInt8(ascii: "]") { i += 1; return .array(array) }
                    throw ParseError()
                }
            case UInt8(ascii: "\""):
                let start = i
                i += 1
                while i < bytes.count, bytes[i] != UInt8(ascii: "\"") { i += bytes[i] == UInt8(ascii: "\\") ? 2 : 1 }
                guard i < bytes.count else { throw ParseError() }
                i += 1
                guard let decoded = try? JSONDecoder().decode(String.self, from: Data(bytes[start..<i])) else { throw ParseError() }
                return .string(decoded)
            case UInt8(ascii: "t"): try expect("true"); return .bool(true)
            case UInt8(ascii: "f"): try expect("false"); return .bool(false)
            case UInt8(ascii: "n"): try expect("null"); return .null
            default:
                let start = i
                while i < bytes.count, "+-0123456789.eE".utf8.contains(bytes[i]) { i += 1 }
                guard i > start, let text = String(bytes: bytes[start..<i], encoding: .ascii), Double(text) != nil else { throw ParseError() }
                return .number(text)
            }
        }
    }

    // MARK: Encoding

    static func quote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "<": out += "\\u003c"
            case ">": out += "\\u003e"
            case "&": out += "\\u0026"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }

    /// json.Encoder output (with its trailing newline); indent "" is compact.
    func encoded(indent: String) -> String {
        func write(_ value: GoJSONValue, _ level: Int) -> String {
            let pad = indent.isEmpty ? "" : "\n" + String(repeating: indent, count: level + 1)
            let close = indent.isEmpty ? "" : "\n" + String(repeating: indent, count: level)
            switch value {
            case .null: return "null"
            case .bool(let b): return b ? "true" : "false"
            case .number(let n): return n
            case .string(let s): return Self.quote(s)
            case .array(let items):
                if items.isEmpty { return "[]" }
                return "[" + items.map { pad + write($0, level + 1) }.joined(separator: ",") + close + "]"
            case .object(let fields):
                if fields.isEmpty { return "{}" }
                let keys = fields.keys.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
                let separator = indent.isEmpty ? ":" : ": "
                return "{" + keys.map { pad + Self.quote($0) + separator + write(fields[$0]!, level + 1) }.joined(separator: ",") + close + "}"
            }
        }
        return write(self, 0) + "\n"
    }
}

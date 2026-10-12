import Foundation

/// JSON as Go's encoding/json sees it with Decoder.UseNumber: numbers keep their
/// literal text, and encoding sorts keys, escapes <>&, U+2028/9 and control
/// characters, and indents like json.Encoder.SetIndent("", "  ").
/// The one JSON writer for anything Go also writes (CLI stdout, generated
/// provider files, hook responses), so output is byte-identical to Go on every
/// OS instead of depending on the platform's JSONSerialization.
public indirect enum GoJSONValue: Equatable, Sendable {
    case object([String: GoJSONValue]), array([GoJSONValue]), string(String), number(String), bool(Bool), null

    public subscript(key: String) -> GoJSONValue? { if case .object(let o) = self { o[key] } else { nil } }
    public var string: String? { if case .string(let s) = self { s } else { nil } }
    public var array: [GoJSONValue]? { if case .array(let a) = self { a } else { nil } }
    public var number: Double? { if case .number(let n) = self { Double(n) } else { nil } }
    public var object: [String: GoJSONValue]? { if case .object(let o) = self { o } else { nil } }

    // MARK: Parsing

    public struct ParseError: Error {}

    /// Like json.Decoder: a value followed by anything is accepted. `strict`
    /// is json.Unmarshal, which rejects trailing data.
    public static func parse(_ data: Data, strict: Bool = false) throws -> GoJSONValue {
        var parser = Parser(bytes: Array(data))
        parser.skipSpace()
        let value = try parser.value()
        parser.skipSpace()
        if strict, parser.i < parser.bytes.count { throw ParseError() }
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
                // Fast path for transcripts: no escapes and no raw control characters.
                let body = bytes[(start + 1)..<(i - 1)]
                if !body.contains(where: { $0 == UInt8(ascii: "\\") || $0 < 0x20 }) { return .string(String(decoding: body, as: UTF8.self)) }
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

    public static func quote(_ s: String) -> String {
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
    public func encoded(indent: String) -> String { marshal(indent: indent) + "\n" }

    /// json.Marshal (indent "") or json.MarshalIndent(v, "", indent): no trailing newline.
    public func marshal(indent: String = "") -> String {
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
        return write(self, 0)
    }

    public var data: Data { Data(marshal().utf8) }

    // MARK: Go float64

    /// The value Go holds after json.Unmarshal into `any`: every number is a float64,
    /// so 1.0 re-encodes as 1 and 1e21 as 1e+21.
    public var float64: GoJSONValue {
        switch self {
        case .object(let o): .object(o.mapValues(\.float64))
        case .array(let a): .array(a.map(\.float64))
        case .number(let n): Double(n).map(Self.float) ?? self
        default: self
        }
    }

    public static func float(_ value: Double) -> GoJSONValue { .number(formatFloat(value)) }
    public static func int(_ value: Int) -> GoJSONValue { .number(String(value)) }

    /// encoding/json's float64 encoder: strconv 'f' with the shortest digits,
    /// switching to 'e' below 1e-6 and from 1e21, with a one-digit negative exponent.
    public static func formatFloat(_ value: Double) -> String {
        guard value.isFinite else { return "null" } // Go fails the whole Marshal; never produced by a parse
        let negative = value.sign == .minus
        // Swift's description is the shortest round-tripping decimal, as is Go's -1 precision.
        var text = "\(abs(value))"
        var exponent = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            exponent = Int(text[text.index(after: e)...]) ?? 0
            text = String(text[..<e])
        }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(parts[0]), fraction = parts.count > 1 ? String(parts[1]) : ""
        // value = 0.digits × 10^point
        var digits = whole + fraction
        var point = whole.count + exponent
        while digits.hasPrefix("0") { digits.removeFirst(); point -= 1 }
        while digits.hasSuffix("0") { digits.removeLast() }
        let sign = negative ? "-" : ""
        if digits.isEmpty { return sign + "0" }
        let magnitude = abs(value)
        if magnitude < 1e-6 || magnitude >= 1e21 {
            let e = point - 1
            let mantissa = digits.count > 1 ? "\(digits.first!)." + digits.dropFirst() : digits
            let exponentText = e < 0 ? "-\(-e)" : (e < 10 ? "+0\(e)" : "+\(e)")
            return sign + mantissa + "e" + exponentText
        }
        if point <= 0 { return sign + "0." + String(repeating: "0", count: -point) + digits }
        if point >= digits.count { return sign + digits + String(repeating: "0", count: point - digits.count) }
        return sign + digits.prefix(point) + "." + digits.dropFirst(point)
    }
}

extension GoJSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(String(value)) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(arrayLiteral elements: GoJSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, GoJSONValue)...) {
        self = .object(Dictionary(elements, uniquingKeysWith: { $1 }))
    }
}

extension GoJSONValue {
    /// A decoded API value as Go holds it after json.Unmarshal into `any`.
    public init(_ value: JSONValue) {
        switch value {
        case .object(let o): self = .object(o.mapValues(GoJSONValue.init))
        case .array(let a): self = .array(a.map(GoJSONValue.init))
        case .string(let s): self = .string(s)
        case .number(let n): self = .float(n)
        case .bool(let b): self = .bool(b)
        case .null: self = .null
        }
    }
}

/// Go encoding conventions the CLI and generated files print.
public enum GoJSON {
    /// json.Marshal of a decoded object.
    public static func encode(_ value: JSONValue) -> String { GoJSONValue(value).marshal() }

    /// url.QueryEscape: spaces become "+", everything but [A-Za-z0-9-_.~] is percent-encoded.
    public static func queryEscape(_ s: String) -> String {
        var out = ""
        for byte in s.utf8 {
            switch byte {
            case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "-"), UInt8(ascii: "_"), UInt8(ascii: "."), UInt8(ascii: "~"): out.unicodeScalars.append(Unicode.Scalar(byte))
            case UInt8(ascii: " "): out += "+"
            default: out += String(format: "%%%02X", byte)
            }
        }
        return out
    }
}

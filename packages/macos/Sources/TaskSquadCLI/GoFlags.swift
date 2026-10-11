import Foundation

/// Go's `flag.FlagSet` with ContinueOnError: same syntax (-x, --x, -x=v, -x v,
/// "--" terminator, stop at the first non-flag) and byte-identical errors and
/// usage, since agents and scripts read what the Go `tsq` prints.
final class GoFlagSet {
    enum Kind { case string(String), int(Int), bool(Bool) }
    private struct Flag { let name: String; let usage: String; let defaultValue: Kind; var value: Kind }
    enum ParseError: Error { case help, failed }

    let name: String
    private var flags: [String: Flag] = [:]
    private(set) var arguments: [String] = []
    private let output: (String) -> Void

    init(_ name: String, output: @escaping (String) -> Void) { self.name = name; self.output = output }

    func string(_ name: String, _ value: String, _ usage: String) { flags[name] = Flag(name: name, usage: usage, defaultValue: .string(value), value: .string(value)) }
    func int(_ name: String, _ value: Int, _ usage: String) { flags[name] = Flag(name: name, usage: usage, defaultValue: .int(value), value: .int(value)) }
    func bool(_ name: String, _ value: Bool, _ usage: String) { flags[name] = Flag(name: name, usage: usage, defaultValue: .bool(value), value: .bool(value)) }

    subscript(string name: String) -> String { if case .string(let v)? = flags[name]?.value { v } else { "" } }
    subscript(int name: String) -> Int { if case .int(let v)? = flags[name]?.value { v } else { 0 } }
    subscript(bool name: String) -> Bool { if case .bool(let v)? = flags[name]?.value { v } else { false } }

    func parse(_ input: [String]) throws {
        var args = input[...]
        while let s = args.first {
            guard s.count >= 2, s.hasPrefix("-") else { break }
            var minuses = 1
            if s.dropFirst().hasPrefix("-") {
                minuses = 2
                if s.count == 2 { args = args.dropFirst(); break } // "--"
            }
            var name = String(s.dropFirst(minuses))
            if name.isEmpty || name.hasPrefix("-") || name.hasPrefix("=") { try fail("bad flag syntax: \(s)") }
            args = args.dropFirst()
            var value: String?
            if let eq = name.dropFirst().firstIndex(of: "=") { value = String(name[name.index(after: eq)...]); name = String(name[..<eq]) }
            guard var flag = flags[name] else {
                if name == "help" || name == "h" { usage(); throw ParseError.help }
                try fail("flag provided but not defined: -\(name)")
            }
            switch flag.defaultValue {
            case .bool:
                if let value {
                    guard let parsed = Self.goBool(value) else { try fail("invalid boolean value \(Self.goQuote(value)) for -\(name): parse error") }
                    flag.value = .bool(parsed)
                } else { flag.value = .bool(true) }
            case .string, .int:
                if value == nil, let next = args.first { value = next; args = args.dropFirst() }
                guard let value else { try fail("flag needs an argument: -\(name)") }
                if case .int = flag.defaultValue {
                    guard let parsed = Self.goInt(value) else { try fail("invalid value \(Self.goQuote(value)) for flag -\(name): parse error") }
                    flag.value = .int(parsed)
                } else { flag.value = .string(value) }
            }
            flags[name] = flag
        }
        arguments = Array(args)
    }

    private func fail(_ message: String) throws -> Never {
        output(message + "\n")
        usage()
        throw ParseError.failed
    }

    func usage() {
        output(name.isEmpty ? "Usage:\n" : "Usage of \(name):\n")
        for flag in flags.values.sorted(by: { $0.name < $1.name }) {
            var line = "  -\(flag.name)"
            let type: String
            switch flag.defaultValue { case .string: type = "string"; case .int: type = "int"; case .bool: type = "" }
            var usage = flag.usage
            var shown = type
            if let open = usage.firstIndex(of: "`"), let close = usage[usage.index(after: open)...].firstIndex(of: "`") {
                shown = String(usage[usage.index(after: open)..<close])
                usage = String(usage[..<open]) + shown + String(usage[usage.index(after: close)...])
            }
            if !shown.isEmpty { line += " " + shown }
            line += line.utf8.count <= 4 ? "\t" : "\n    \t"
            line += usage.replacingOccurrences(of: "\n", with: "\n    \t")
            switch flag.defaultValue {
            case .string(let v) where !v.isEmpty: line += " (default \(Self.goQuote(v)))"
            case .int(let v) where v != 0: line += " (default \(v))"
            case .bool(let v) where v: line += " (default true)"
            default: break
            }
            output(line + "\n")
        }
    }

    /// strconv.ParseBool.
    static func goBool(_ s: String) -> Bool? {
        switch s {
        case "1", "t", "T", "TRUE", "true", "True": true
        case "0", "f", "F", "FALSE", "false", "False": false
        default: nil
        }
    }

    /// strconv.ParseInt(s, 0, 64): optional sign, 0x/0o/0b/0 prefixes, underscores between digits.
    static func goInt(_ text: String) -> Int? {
        var s = Substring(text), negative = false
        if s.hasPrefix("+") || s.hasPrefix("-") { negative = s.first == "-"; s = s.dropFirst() }
        var radix = 10
        let lower = s.lowercased()
        if lower.hasPrefix("0x") { radix = 16; s = s.dropFirst(2) }
        else if lower.hasPrefix("0o") { radix = 8; s = s.dropFirst(2) }
        else if lower.hasPrefix("0b") { radix = 2; s = s.dropFirst(2) }
        else if s.count > 1, s.hasPrefix("0") { radix = 8; s = s.dropFirst() }
        if radix != 10 || text.contains("_") {
            guard !s.hasPrefix("_"), !s.hasSuffix("_"), !s.contains("__") else { return nil }
            s = Substring(s.replacingOccurrences(of: "_", with: ""))
        }
        guard !s.isEmpty, let magnitude = Int(s, radix: radix) else { return nil }
        return negative ? -magnitude : magnitude
    }

    /// Go's %q for the ASCII-ish values flags carry.
    static func goQuote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\t": out += "\\t"
            case "\r": out += "\\r"
            default:
                if scalar.value < 0x20 || scalar.value == 0x7F { out += String(format: "\\x%02x", scalar.value) }
                else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }
}

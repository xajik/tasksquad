import Foundation
import Darwin

public enum TerminalColor: Sendable, Equatable { case indexed(Int), rgb(Int, Int, Int) }
public struct TerminalStyle: Sendable, Equatable {
    public var foreground: TerminalColor?
    public var background: TerminalColor?
    public var bold = false, dim = false, italic = false, underline = false, inverse = false, strike = false
}
public struct TerminalSpan: Sendable, Equatable { public let text: String; public let style: TerminalStyle }
public enum TerminalANSI {
    /// tmux performs VT emulation; capture-pane emits only screen text and SGR.
    public static func lines(_ source: String) -> [[TerminalSpan]] {
        let scalars = Array(source.unicodeScalars)
        var lines: [[TerminalSpan]] = [[]], text = "", style = TerminalStyle(), i = 0
        func flush() { if !text.isEmpty { lines[lines.count - 1].append(TerminalSpan(text: text, style: style)); text = "" } }
        while i < scalars.count {
            let c = scalars[i]; i += 1
            if c.value == 10 { flush(); lines.append([]); continue }
            if c.value == 27 {
                flush(); guard i < scalars.count else { break }
                let kind = scalars[i]; i += 1
                if kind == "[" {
                    let start = i
                    while i < scalars.count && !(0x40...0x7e).contains(scalars[i].value) { i += 1 }
                    if i < scalars.count && scalars[i] == "m" { apply(String(String.UnicodeScalarView(scalars[start..<i])), style: &style) }
                    i = min(i + 1, scalars.count)
                } else if kind == "]" || kind == "P" {
                    while i < scalars.count {
                        if scalars[i].value == 7 { i += 1; break }
                        if scalars[i].value == 27 && i + 1 < scalars.count && scalars[i + 1] == "\\" { i += 2; break }
                        i += 1
                    }
                } else if ["(", ")"].contains(kind) { i = min(i + 1, scalars.count) }
                continue
            }
            if c.value >= 32 && c.value != 127 { text.unicodeScalars.append(c) }
        }
        flush(); return lines
    }
    public static func plain(_ source: String) -> String { lines(source).map { $0.map(\.text).joined() }.joined(separator: "\n") }
    // ';' always separates top-level SGR codes. ':' only separates sub-parameters
    // *within* an extended color code (38/48/58) — e.g. "38:2::255:0:0" is one
    // code with its own params, not four independent codes. Blindly rewriting
    // every ':' to ';' before splitting corrupts unrelated codes that follow.
    private static func apply(_ parameters: String, style: inout TerminalStyle) {
        let groups = parameters.components(separatedBy: ";").map { $0.components(separatedBy: ":").map { Int($0) ?? 0 } }
        var i = 0
        // Legacy (semicolon) extended-color form: the code's params are their
        // own top-level groups, e.g. "38;5;idx" or "38;2;r;g;b".
        func legacyColor() -> TerminalColor? {
            guard i < groups.count, groups[i].count == 1 else { return nil }
            let kind = groups[i][0]
            if kind == 5, i + 1 < groups.count, groups[i + 1].count == 1 {
                defer { i += 2 }
                return .indexed(groups[i + 1][0])
            }
            if kind == 2, i + 3 < groups.count, groups[i + 1].count == 1, groups[i + 2].count == 1, groups[i + 3].count == 1 {
                defer { i += 4 }
                return .rgb(groups[i + 1][0], groups[i + 2][0], groups[i + 3][0])
            }
            return nil
        }
        while i < groups.count {
            let group = groups[i]; i += 1
            let code = group[0]
            switch code {
            case 0: style = TerminalStyle()
            case 1: style.bold = true
            case 2: style.dim = true
            case 3: style.italic = true
            case 4, 21: style.underline = true
            case 7: style.inverse = true
            case 9: style.strike = true
            case 22: style.bold = false; style.dim = false
            case 23: style.italic = false
            case 24: style.underline = false
            case 27: style.inverse = false
            case 29: style.strike = false
            case 30...37: style.foreground = .indexed(code - 30)
            case 40...47: style.background = .indexed(code - 40)
            case 90...97: style.foreground = .indexed(code - 90 + 8)
            case 100...107: style.background = .indexed(code - 100 + 8)
            case 39: style.foreground = nil
            case 49: style.background = nil
            case 38, 48, 58:
                var color: TerminalColor?
                if group.count > 1 {
                    // Colon form: "38:5:idx" or "38:2:r:g:b" / "38:2:cs:r:g:b".
                    let kind = group[1]
                    if kind == 5, group.count > 2 { color = .indexed(group[2]) }
                    else if kind == 2, group.count > 4 { color = .rgb(group[group.count - 3], group[group.count - 2], group[group.count - 1]) }
                } else {
                    color = legacyColor()
                }
                // 58 (underline color) is consumed to stay in sync but not rendered.
                if code == 38 { style.foreground = color } else if code == 48 { style.background = color }
            default: break
            }
        }
    }
    public static func columns(_ character: Character) -> Int {
        let widths = character.unicodeScalars.map { max(0, Int(wcwidth(wchar_t($0.value)))) }
        if character.unicodeScalars.contains(where: { $0.value == 0xfe0f || $0.value == 0x200d || $0.properties.isEmojiPresentation }) { return max(2, widths.max() ?? 1) }
        return max(1, widths.max() ?? 1)
    }
}

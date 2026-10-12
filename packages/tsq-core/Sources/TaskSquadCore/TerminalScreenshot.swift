import Foundation

/// Renders a tmux pane (ANSI colors and attributes kept) to PNG. Port of
/// packages/daemon/screenshot: capture, grid parser, palette and Go's cell metrics
/// live here; only rasterizing is OS-specific (`PlatformServices.renderScreenshot`),
/// and every renderer draws the embedded JetBrains Mono into these cells, so images
/// have Go's exact dimensions.
public enum TerminalScreenshot {
    public struct RGBA: Equatable, Sendable {
        public var r: UInt8, g: UInt8, b: UInt8, a: UInt8 = 0xFF
        public init(_ r: UInt8, _ g: UInt8, _ b: UInt8, _ a: UInt8 = 0xFF) { self.r = r; self.g = g; self.b = b; self.a = a }
    }
    public struct Cell: Equatable, Sendable {
        public var scalar: Unicode.Scalar = " "
        public var fg = defaultFG, bg = defaultBG
        public var bold = false, dim = false, underline = false, reverse = false, strike = false
        public init() {}
        init(scalar: Unicode.Scalar, fg: RGBA, bg: RGBA, bold: Bool, dim: Bool, underline: Bool, reverse: Bool, strike: Bool) {
            self.scalar = scalar; self.fg = fg; self.bg = bg
            self.bold = bold; self.dim = dim; self.underline = underline; self.reverse = reverse; self.strike = strike
        }
    }

    public static let defaultFG = RGBA(0xD4, 0xD4, 0xD4)
    public static let defaultBG = RGBA(0x0C, 0x0C, 0x0C)
    public static let ansi16: [RGBA] = [
        RGBA(0x00, 0x00, 0x00), RGBA(0xCD, 0x00, 0x00), RGBA(0x00, 0xCD, 0x00), RGBA(0xCD, 0xCD, 0x00),
        RGBA(0x00, 0x00, 0xEE), RGBA(0xCD, 0x00, 0xCD), RGBA(0x00, 0xCD, 0xCD), RGBA(0xE5, 0xE5, 0xE5),
        RGBA(0x7F, 0x7F, 0x7F), RGBA(0xFF, 0x00, 0x00), RGBA(0x00, 0xFF, 0x00), RGBA(0xFF, 0xFF, 0x00),
        RGBA(0x5C, 0x5C, 0xFF), RGBA(0xFF, 0x00, 0xFF), RGBA(0x00, 0xFF, 0xFF), RGBA(0xFF, 0xFF, 0xFF),
    ]
    /// Go's JetBrains Mono 16pt @72dpi cells (x/image/font metrics), fixed so sizes match exactly.
    public static let cellWidth = 10, cellHeight = 22, cellAscent = 17
    public static let fontSize = 16

    /// Captures and renders a pane; scrollbackLines > 0 also includes history.
    public static func capture(session: String, scrollbackLines: Int = 0, tmux: TmuxConnection = TmuxConnection()) async throws -> Data {
        try Platform.current.renderScreenshot(try await grid(session: session, scrollbackLines: scrollbackLines, tmux: tmux))
    }

    /// Go's Capture up to rendering: the pane's cells at its width.
    public static func grid(session: String, scrollbackLines: Int = 0, tmux: TmuxConnection = TmuxConnection()) async throws -> [[Cell]] {
        var arguments = ["capture-pane", "-t", session, "-e", "-p"]
        if scrollbackLines > 0 { arguments += ["-S", "-\(scrollbackLines)"] }
        let raw: String
        do { raw = try await tmux.run(arguments) } catch { throw ConfigurationError("tmux capture-pane: \(error.localizedDescription)") }
        var columns = Int((try? await tmux.run(["display-message", "-t", session, "-p", "#{pane_width}"]))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
        // Rare race (session vanished between calls): approximate so an image is still produced.
        if columns <= 0 { columns = raw.components(separatedBy: "\n").map { $0.unicodeScalars.count }.max() ?? 0 }
        if columns <= 0 { columns = 80 }
        return parseGrid(raw, columns: columns)
    }

    // MARK: Parsing (Go: sgr.go)

    public static func color256(_ index: Int) -> RGBA {
        func cube(_ n: Int) -> UInt8 { n == 0 ? 0 : UInt8(55 + 40 * n) }
        switch index {
        case ..<16: return ansi16[max(index, 0)]
        case ..<232: let i = index - 16; return RGBA(cube(i / 36), cube((i / 6) % 6), cube(i % 6))
        default: let v = UInt8(clamping: 8 + 10 * (index - 232)); return RGBA(v, v, v)
        }
    }

    private struct State {
        var fg = defaultFG, bg = defaultBG
        var bold = false, dim = false, underline = false, reverse = false, strike = false
        func cell(_ scalar: Unicode.Scalar) -> Cell {
            Cell(scalar: scalar, fg: fg, bg: bg, bold: bold, dim: dim, underline: underline, reverse: reverse, strike: strike)
        }
        mutating func apply(_ raw: [String]) {
            let params = raw.isEmpty ? ["0"] : raw
            var i = 0
            while i < params.count {
                let p = Int(params[i]) ?? 0
                switch p {
                case 0: self = State()
                case 1: bold = true
                case 2: dim = true
                case 4: underline = true
                case 7: reverse = true
                case 9: strike = true
                case 22: bold = false; dim = false
                case 24: underline = false
                case 27: reverse = false
                case 29: strike = false
                case 30...37: fg = ansi16[p - 30]
                case 38: let (c, n) = extendedColor(Array(params[(i + 1)...])); fg = c; i += n
                case 39: fg = defaultFG
                case 40...47: bg = ansi16[p - 40]
                case 48: let (c, n) = extendedColor(Array(params[(i + 1)...])); bg = c; i += n
                case 49: bg = defaultBG
                case 90...97: fg = ansi16[8 + p - 90]
                case 100...107: bg = ansi16[8 + p - 100]
                default: break
                }
                i += 1
            }
        }
    }

    /// "5;N" (256-color) or "2;r;g;b" (truecolor) after 38/48; returns the color and parameters consumed.
    private static func extendedColor(_ rest: [String]) -> (RGBA, Int) {
        guard let first = rest.first else { return (defaultFG, 0) }
        switch Int(first) ?? 0 {
        case 5:
            guard rest.count >= 2 else { return (defaultFG, 1) }
            return (color256(Int(rest[1]) ?? 0), 2)
        case 2:
            guard rest.count >= 4 else { return (defaultFG, rest.count) }
            func byte(_ s: String) -> UInt8 { UInt8(truncatingIfNeeded: Int(s) ?? 0) }
            return (RGBA(byte(rest[1]), byte(rest[2]), byte(rest[3])), 4)
        default:
            return (defaultFG, 1)
        }
    }

    /// SGR state carries across lines: tmux does not re-emit it at each line start.
    public static func parseGrid(_ raw: String, columns: Int) -> [[Cell]] {
        var rows: [[Cell]] = []
        var row: [Cell] = []
        var state = State()
        let scalars = Array(raw.unicodeScalars)
        func pad(_ row: [Cell]) -> [Cell] { row + Array(repeating: Cell(), count: max(columns - row.count, 0)) }
        var i = 0
        while i < scalars.count {
            let c = scalars[i]
            switch c {
            case "\u{1b}":
                if i + 1 < scalars.count, scalars[i + 1] == "[" {
                    var j = i + 2
                    let start = j
                    while j < scalars.count, !(0x40...0x7E).contains(scalars[j].value) { j += 1 }
                    if j < scalars.count {
                        if scalars[j] == "m" {
                            let params = String(String.UnicodeScalarView(scalars[start..<j]))
                            state.apply(params.components(separatedBy: ";"))
                        }
                        i = j
                    } else { i = scalars.count } // unterminated sequence: stop
                }
            case "\r": break
            case "\n": rows.append(pad(row)); row = []
            default: if row.count < columns { row.append(state.cell(c)) }
            }
            i += 1
        }
        rows.append(pad(row))
        return rows
    }

    // MARK: Rendering helpers (Go: render.go)

    /// Reverse video and dim applied: the colors a renderer draws.
    public static func drawColors(_ cell: Cell) -> (fg: RGBA, bg: RGBA) {
        var fg = cell.fg, bg = cell.bg
        if cell.reverse { swap(&fg, &bg) }
        if cell.dim { fg = RGBA(UInt8(Double(fg.r) * 0.6), UInt8(Double(fg.g) * 0.6), UInt8(Double(fg.b) * 0.6), fg.a) }
        return (fg, bg)
    }
}

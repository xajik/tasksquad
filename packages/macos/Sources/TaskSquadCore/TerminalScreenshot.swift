import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Renders a tmux pane (ANSI colors and attributes kept) to PNG.
/// Port of packages/daemon/screenshot: the same grid parser, palette, embedded
/// JetBrains Mono and cell metrics, so images have Go's exact dimensions.
public enum TerminalScreenshot {
    public struct RGBA: Equatable, Sendable {
        public var r: UInt8, g: UInt8, b: UInt8, a: UInt8 = 0xFF
        public init(_ r: UInt8, _ g: UInt8, _ b: UInt8, _ a: UInt8 = 0xFF) { self.r = r; self.g = g; self.b = b; self.a = a }
    }
    struct Cell: Equatable {
        var scalar: Unicode.Scalar = " "
        var fg = defaultFG, bg = defaultBG
        var bold = false, dim = false, underline = false, reverse = false, strike = false
    }

    static let defaultFG = RGBA(0xD4, 0xD4, 0xD4)
    static let defaultBG = RGBA(0x0C, 0x0C, 0x0C)
    static let ansi16: [RGBA] = [
        RGBA(0x00, 0x00, 0x00), RGBA(0xCD, 0x00, 0x00), RGBA(0x00, 0xCD, 0x00), RGBA(0xCD, 0xCD, 0x00),
        RGBA(0x00, 0x00, 0xEE), RGBA(0xCD, 0x00, 0xCD), RGBA(0x00, 0xCD, 0xCD), RGBA(0xE5, 0xE5, 0xE5),
        RGBA(0x7F, 0x7F, 0x7F), RGBA(0xFF, 0x00, 0x00), RGBA(0x00, 0xFF, 0x00), RGBA(0xFF, 0xFF, 0x00),
        RGBA(0x5C, 0x5C, 0xFF), RGBA(0xFF, 0x00, 0xFF), RGBA(0x00, 0xFF, 0xFF), RGBA(0xFF, 0xFF, 0xFF),
    ]
    /// Go's JetBrains Mono 16pt @72dpi cells (x/image/font metrics), fixed so sizes match exactly.
    static let cellWidth = 10, cellHeight = 22, cellAscent = 17
    static let fontSize: CGFloat = 16

    /// Captures and renders a pane; scrollbackLines > 0 also includes history.
    public static func capture(session: String, scrollbackLines: Int = 0, tmux: TmuxConnection = TmuxConnection()) async throws -> Data {
        var arguments = ["capture-pane", "-t", session, "-e", "-p"]
        if scrollbackLines > 0 { arguments += ["-S", "-\(scrollbackLines)"] }
        let raw: String
        do { raw = try await tmux.run(arguments) } catch { throw ConfigurationError("tmux capture-pane: \(error.localizedDescription)") }
        var columns = Int((try? await tmux.run(["display-message", "-t", session, "-p", "#{pane_width}"]))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
        // Rare race (session vanished between calls): approximate so an image is still produced.
        if columns <= 0 { columns = raw.components(separatedBy: "\n").map { $0.unicodeScalars.count }.max() ?? 0 }
        if columns <= 0 { columns = 80 }
        return try render(parseGrid(raw, columns: columns))
    }

    // MARK: Parsing (Go: sgr.go)

    static func color256(_ index: Int) -> RGBA {
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
    static func parseGrid(_ raw: String, columns: Int) -> [[Cell]] {
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

    // MARK: Rendering (Go: render.go, font.go)

    private static func drawColors(_ cell: Cell) -> (fg: RGBA, bg: RGBA) {
        var fg = cell.fg, bg = cell.bg
        if cell.reverse { swap(&fg, &bg) }
        if cell.dim { fg = RGBA(UInt8(Double(fg.r) * 0.6), UInt8(Double(fg.g) * 0.6), UInt8(Double(fg.b) * 0.6), fg.a) }
        return (fg, bg)
    }

    private static func cgColor(_ c: RGBA) -> CGColor {
        CGColor(srgbRed: CGFloat(c.r) / 255, green: CGFloat(c.g) / 255, blue: CGFloat(c.b) / 255, alpha: CGFloat(c.a) / 255)
    }

    /// The fonts ship in the TaskSquadCore resource bundle. Looked up by hand rather
    /// than Bundle.module, which traps when a bare CLI binary ships without it.
    private static func font(bold: Bool) -> CTFont {
        let name = bold ? "JetBrainsMono-Bold.ttf" : "JetBrainsMono-Regular.ttf"
        let bundleName = "TaskSquad_TaskSquadCore.bundle"
        let executable = URL(fileURLWithPath: CommandLine.arguments.first ?? "").resolvingSymlinksInPath().deletingLastPathComponent()
        let roots = [Bundle.main.resourceURL, Bundle.main.bundleURL, executable, executable.appendingPathComponent("../Resources")]
            + Bundle.allBundles.map(\.bundleURL)
        for root in roots.compactMap({ $0 }) {
            for candidate in [root.appendingPathComponent("\(bundleName)/Fonts/\(name)"),
                              root.appendingPathComponent("\(bundleName)/Contents/Resources/Fonts/\(name)"),
                              root.appendingPathComponent("Fonts/\(name)")] {
                if let data = try? Data(contentsOf: candidate) as CFData, let descriptor = CTFontManagerCreateFontDescriptorFromData(data) {
                    return CTFontCreateWithFontDescriptor(descriptor, fontSize, nil)
                }
            }
        }
        return CTFontCreateUIFontForLanguage(.userFixedPitch, fontSize, nil) ?? CTFontCreateWithName("Menlo" as CFString, fontSize, nil)
    }

    static func render(_ input: [[Cell]]) throws -> Data {
        var grid = input
        if grid.isEmpty || grid[0].isEmpty { grid = [[Cell()]] }
        let rows = grid.count, columns = grid[0].count
        let width = columns * cellWidth, height = rows * cellHeight
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw ConfigurationError("could not create screenshot bitmap") }
        // Top-left origin like Go's image package.
        context.translateBy(x: 0, y: CGFloat(height)); context.scaleBy(x: 1, y: -1)
        for (y, row) in grid.enumerated() {
            for (x, cell) in row.enumerated() {
                context.setFillColor(cgColor(drawColors(cell).bg))
                context.fill(CGRect(x: x * cellWidth, y: y * cellHeight, width: cellWidth, height: cellHeight))
            }
        }
        let regular = font(bold: false), bold = font(bold: true)
        for (y, row) in grid.enumerated() {
            let baseline = y * cellHeight + cellAscent
            for (x, cell) in row.enumerated() where cell.scalar != " " && cell.scalar.value != 0 {
                let fg = drawColors(cell).fg
                let attributes: [CFString: Any] = [kCTFontAttributeName: cell.bold ? bold : regular, kCTForegroundColorAttributeName: cgColor(fg)]
                let line = CTLineCreateWithAttributedString(CFAttributedStringCreate(nil, String(cell.scalar) as CFString, attributes as CFDictionary))
                context.saveGState()
                // Glyphs draw upright: flip back around this baseline.
                context.textMatrix = .identity
                context.translateBy(x: CGFloat(x * cellWidth), y: CGFloat(baseline)); context.scaleBy(x: 1, y: -1)
                context.textPosition = .zero
                CTLineDraw(line, context)
                context.restoreGState()
                context.setFillColor(cgColor(fg))
                if cell.underline { context.fill(CGRect(x: x * cellWidth, y: baseline + 2, width: cellWidth, height: 1)) }
                if cell.strike { context.fill(CGRect(x: x * cellWidth, y: y * cellHeight + cellHeight / 2, width: cellWidth, height: 1)) }
            }
        }
        guard let image = context.makeImage() else { throw ConfigurationError("could not render screenshot") }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil)
        else { throw ConfigurationError("could not encode screenshot") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw ConfigurationError("could not encode screenshot") }
        return output as Data
    }
}

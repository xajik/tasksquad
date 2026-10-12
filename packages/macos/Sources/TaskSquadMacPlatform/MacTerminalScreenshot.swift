import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers
import TaskSquadCore

/// CoreText rasterizer for TerminalScreenshot grids (Go: render.go, font.go).
public enum MacTerminalScreenshot {
    public typealias Cell = TerminalScreenshot.Cell
    public typealias RGBA = TerminalScreenshot.RGBA
    static let cellWidth = TerminalScreenshot.cellWidth, cellHeight = TerminalScreenshot.cellHeight
    static let cellAscent = TerminalScreenshot.cellAscent
    static let fontSize = CGFloat(TerminalScreenshot.fontSize)

    private static func cgColor(_ c: RGBA) -> CGColor {
        CGColor(srgbRed: CGFloat(c.r) / 255, green: CGFloat(c.g) / 255, blue: CGFloat(c.b) / 255, alpha: CGFloat(c.a) / 255)
    }

    /// The fonts ship in the TaskSquadMacPlatform resource bundle. Looked up by hand rather
    /// than Bundle.module, which traps when a bare CLI binary ships without it.
    private static func font(bold: Bool) -> CTFont {
        let name = bold ? "JetBrainsMono-Bold.ttf" : "JetBrainsMono-Regular.ttf"
        let bundleName = "TaskSquad_TaskSquadMacPlatform.bundle"
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

    public static func render(_ input: [[Cell]]) throws -> Data {
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
                context.setFillColor(cgColor(TerminalScreenshot.drawColors(cell).bg))
                context.fill(CGRect(x: x * cellWidth, y: y * cellHeight, width: cellWidth, height: cellHeight))
            }
        }
        let regular = font(bold: false), bold = font(bold: true)
        for (y, row) in grid.enumerated() {
            let baseline = y * cellHeight + cellAscent
            for (x, cell) in row.enumerated() where cell.scalar != " " && cell.scalar.value != 0 {
                let fg = TerminalScreenshot.drawColors(cell).fg
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

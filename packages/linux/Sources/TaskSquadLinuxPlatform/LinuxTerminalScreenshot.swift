import Foundation
import TaskSquadCore

/// Rasterizer for TerminalScreenshot grids (Go: render.go, font.go): the embedded
/// JetBrains Mono at 16px drawn unhinted into Go's 10×22 cells, fg composited over
/// each cell's bg by coverage, underline at baseline+2, strike at mid-cell.
enum LinuxTerminalScreenshot {
    typealias Cell = TerminalScreenshot.Cell

    private final class Faces: @unchecked Sendable {
        let regular: TrueTypeFont?, bold: TrueTypeFont?
        private let lock = NSLock()
        private var cache: [Int: GlyphBitmap] = [:]
        init() {
            regular = try? TrueTypeFont(PackageResources.JetBrainsMono_Regular_ttf)
            bold = try? TrueTypeFont(PackageResources.JetBrainsMono_Bold_ttf)
        }
        func glyph(_ scalar: Unicode.Scalar, bold isBold: Bool) -> GlyphBitmap {
            guard let font = (isBold ? bold : nil) ?? regular else { return .empty }
            let index = font.glyphIndex(scalar)
            let key = index << 1 | (isBold && bold != nil ? 1 : 0)
            if let cached = lock.withLock({ cache[key] }) { return cached }
            let bitmap = GlyphBitmap(contours: font.contours(index), scale: Double(TerminalScreenshot.fontSize) / Double(font.unitsPerEm))
            lock.withLock { cache[key] = bitmap }
            return bitmap
        }
    }
    private static let faces = Faces()

    static func render(_ input: [[Cell]]) throws -> Data {
        var grid = input
        if grid.isEmpty || grid[0].isEmpty { grid = [[Cell()]] }
        let cellWidth = TerminalScreenshot.cellWidth, cellHeight = TerminalScreenshot.cellHeight
        let rows = grid.count, columns = grid[0].count
        let width = columns * cellWidth, height = rows * cellHeight
        guard faces.regular != nil else { throw ConfigurationError("screenshot: failed to load embedded regular font") }
        var pixels = [UInt8](repeating: 0, count: width * height * 4)

        func set(_ x: Int, _ y: Int, _ c: TerminalScreenshot.RGBA) {
            guard x >= 0, y >= 0, x < width, y < height else { return }
            let i = (y * width + x) * 4
            pixels[i] = c.r; pixels[i + 1] = c.g; pixels[i + 2] = c.b; pixels[i + 3] = c.a
        }
        for (y, row) in grid.enumerated() {
            for (x, cell) in row.enumerated() {
                let bg = TerminalScreenshot.drawColors(cell).bg
                for py in (y * cellHeight)..<((y + 1) * cellHeight) { for px in (x * cellWidth)..<((x + 1) * cellWidth) { set(px, py, bg) } }
            }
        }
        for (y, row) in grid.enumerated() {
            let baseline = y * cellHeight + TerminalScreenshot.cellAscent
            for (x, cell) in row.enumerated() where cell.scalar != " " && cell.scalar.value != 0 {
                let fg = TerminalScreenshot.drawColors(cell).fg
                let glyph = faces.glyph(cell.scalar, bold: cell.bold)
                let originX = x * cellWidth + glyph.left, originY = baseline + glyph.top
                for gy in 0..<glyph.height {
                    for gx in 0..<glyph.width {
                        let alpha = glyph.coverage[gy * glyph.width + gx]
                        guard alpha > 0 else { continue }
                        let px = originX + gx, py = originY + gy
                        guard px >= 0, py >= 0, px < width, py < height else { continue }
                        // draw.Over with a uniform source: dst = src·a + dst·(1−a).
                        let i = (py * width + px) * 4
                        func blend(_ s: UInt8, _ d: UInt8) -> UInt8 { UInt8((Float(s) * alpha + Float(d) * (1 - alpha)).rounded()) }
                        pixels[i] = blend(fg.r, pixels[i]); pixels[i + 1] = blend(fg.g, pixels[i + 1]); pixels[i + 2] = blend(fg.b, pixels[i + 2])
                        pixels[i + 3] = 0xFF
                    }
                }
                if cell.underline { for px in (x * cellWidth)..<((x + 1) * cellWidth) { set(px, baseline + 2, fg) } }
                if cell.strike { for px in (x * cellWidth)..<((x + 1) * cellWidth) { set(px, y * cellHeight + cellHeight / 2, fg) } }
            }
        }
        return PNGEncoder.encode(width: width, height: height, rgba: pixels)
    }
}

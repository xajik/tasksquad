import Foundation

/// Antialiased coverage for TrueType outlines: signed-area accumulation (the
/// font-rs algorithm, which Go's golang.org/x/image/vector also uses), with
/// quadratic segments flattened to lines.
struct GlyphBitmap {
    /// Offset of the bitmap's top-left from the pen position (pixels, y down).
    let left: Int, top: Int
    let width: Int, height: Int
    /// Row-major coverage in 0...1.
    let coverage: [Float]

    static let empty = GlyphBitmap(left: 0, top: 0, width: 0, height: 0, coverage: [])

    init(left: Int, top: Int, width: Int, height: Int, coverage: [Float]) {
        self.left = left; self.top = top; self.width = width; self.height = height; self.coverage = coverage
    }

    /// Renders `contours` (font units, y up) at `scale` pixels per unit.
    init(contours: [TrueTypeFont.Contour], scale: Double) {
        let points = contours.flatMap { $0.map(\.point) }
        guard let minX = points.map(\.x).min(), let maxX = points.map(\.x).max(),
              let minY = points.map(\.y).min(), let maxY = points.map(\.y).max() else { self = .empty; return }
        let left = Int((minX * scale).rounded(.down)), top = Int((-maxY * scale).rounded(.down))
        let width = Int((maxX * scale).rounded(.up)) - left + 1, height = Int((-minY * scale).rounded(.up)) - top + 1
        var raster = Accumulator(width: width, height: height)
        // Pixel space: x right, y down, relative to the bitmap origin.
        func map(_ p: TrueTypeFont.Point) -> (Double, Double) { (p.x * scale - Double(left), -p.y * scale - Double(top)) }
        for contour in contours where contour.count > 1 {
            // Start on an on-curve point (or the midpoint of two leading controls).
            let n = contour.count
            let startIndex = contour.firstIndex { $0.onCurve }
            let start: (Double, Double)
            if let startIndex { start = map(contour[startIndex].point) }
            else { let a = map(contour[0].point), b = map(contour[1].point); start = ((a.0 + b.0) / 2, (a.1 + b.1) / 2) }
            var current = start
            var control: (Double, Double)?
            let first = startIndex ?? 0
            for step in 1...n {
                let entry = contour[(first + step) % n]
                let p = map(entry.point)
                if entry.onCurve {
                    if let c = control { raster.quad(current, c, p) } else { raster.line(current, p) }
                    current = p; control = nil
                } else if let c = control {
                    let mid = ((c.0 + p.0) / 2, (c.1 + p.1) / 2)
                    raster.quad(current, c, mid)
                    current = mid; control = p
                } else {
                    control = p
                }
            }
            if let c = control { raster.quad(current, c, start) } else if current != start { raster.line(current, start) }
        }
        self.init(left: left, top: top, width: width, height: height, coverage: raster.coverage())
    }
}

private struct Accumulator {
    let width: Int, height: Int
    var buffer: [Float]

    init(width: Int, height: Int) {
        self.width = width; self.height = height
        buffer = [Float](repeating: 0, count: width * height + 4)
    }

    mutating func quad(_ p0: (Double, Double), _ p1: (Double, Double), _ p2: (Double, Double)) {
        let ddx = p0.0 - 2 * p1.0 + p2.0, ddy = p0.1 - 2 * p1.1 + p2.1
        let deviation = ddx * ddx + ddy * ddy
        guard deviation >= 0.333 else { line(p0, p2); return }
        let segments = 1 + Int((3 * deviation).squareRoot().squareRoot())
        var previous = p0
        for i in 1...segments {
            let t = Double(i) / Double(segments), u = 1 - t
            let p = (u * u * p0.0 + 2 * u * t * p1.0 + t * t * p2.0, u * u * p0.1 + 2 * u * t * p1.1 + t * t * p2.1)
            line(previous, p)
            previous = p
        }
    }

    mutating func line(_ a: (Double, Double), _ b: (Double, Double)) {
        guard a.1 != b.1 else { return }
        let (direction, p0, p1): (Float, (Double, Double), (Double, Double)) = a.1 < b.1 ? (1, a, b) : (-1, b, a)
        let dxdy = (p1.0 - p0.0) / (p1.1 - p0.1)
        var x = p0.0
        if p0.1 < 0 { x -= p0.1 * dxdy }
        let yStart = max(0, Int(p0.1.rounded(.down))), yEnd = min(height, Int(p1.1.rounded(.up)))
        guard yStart < yEnd else { return }
        for y in yStart..<yEnd {
            let row = y * width
            let dy = min(Double(y + 1), p1.1) - max(Double(y), p0.1)
            let xNext = x + dxdy * dy
            let d = Float(dy) * direction
            let (x0, x1) = x < xNext ? (x, xNext) : (xNext, x)
            let x0Floor = x0.rounded(.down), x1Ceil = x1.rounded(.up)
            let x0i = Int(x0Floor), x1i = Int(x1Ceil)
            if x1i <= x0i + 1 {
                let xmf = Float(0.5 * (x + xNext) - x0Floor)
                add(row, x0i, d - d * xmf)
                add(row, x0i + 1, d * xmf)
            } else {
                let s = Float(1 / (x1 - x0))
                let x0f = Float(x0 - x0Floor)
                let a0 = 0.5 * s * (1 - x0f) * (1 - x0f)
                let x1f = Float(x1 - x1Ceil + 1)
                let am = 0.5 * s * x1f * x1f
                add(row, x0i, d * a0)
                if x1i == x0i + 2 {
                    add(row, x0i + 1, d * (1 - a0 - am))
                } else {
                    let a1 = s * (1.5 - x0f)
                    add(row, x0i + 1, d * (a1 - a0))
                    if x0i + 2 < x1i - 1 { for xi in (x0i + 2)..<(x1i - 1) { add(row, xi, d * s) } }
                    let a2 = a1 + Float(x1i - x0i - 3) * s
                    add(row, x1i - 1, d * (1 - a2 - am))
                }
                add(row, x1i, d * am)
            }
            x = xNext
        }
    }

    private mutating func add(_ row: Int, _ x: Int, _ value: Float) {
        let index = row + min(max(x, 0), width - 1) // the +1 margin keeps x in range; never spill into the next row
        if index < buffer.count { buffer[index] += value }
    }

    /// Running sum per row; |area| clamped to 1 is the coverage.
    func coverage() -> [Float] {
        var out = [Float](repeating: 0, count: width * height)
        for y in 0..<height {
            var sum: Float = 0
            for x in 0..<width {
                sum += buffer[y * width + x]
                out[y * width + x] = min(abs(sum), 1)
            }
        }
        return out
    }
}

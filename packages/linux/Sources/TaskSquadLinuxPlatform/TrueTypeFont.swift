/// Minimal TrueType reader for the embedded JetBrains Mono: character map,
/// horizontal metrics and glyph outlines (simple and composite). Like Go's
/// golang.org/x/image/font/sfnt it runs no hinting instructions.
struct TrueTypeFont {
    struct Point { var x: Double, y: Double }
    /// A closed contour of quadratic segments: on-curve points with optional controls.
    typealias Contour = [(point: Point, onCurve: Bool)]

    struct FontError: Error {}

    private let data: [UInt8]
    private let tables: [String: (offset: Int, length: Int)]
    let unitsPerEm: Int
    let ascender: Int, descender: Int
    private let numGlyphs: Int
    private let longLoca: Bool
    private let numberOfHMetrics: Int
    private var cmap: [UInt32: Int] = [:]

    init(_ bytes: [UInt8]) throws {
        data = bytes
        guard bytes.count >= 12 else { throw FontError() }
        var tables: [String: (Int, Int)] = [:]
        let count = Int(Self.u16(bytes, 4))
        for i in 0..<count {
            let record = 12 + i * 16
            guard record + 16 <= bytes.count else { throw FontError() }
            let tag = String(decoding: bytes[record..<record + 4], as: UTF8.self)
            tables[tag] = (Int(Self.u32(bytes, record + 8)), Int(Self.u32(bytes, record + 12)))
        }
        self.tables = tables
        guard let head = tables["head"], let maxp = tables["maxp"], let hhea = tables["hhea"],
              tables["hmtx"] != nil, tables["loca"] != nil, tables["glyf"] != nil, let cmapTable = tables["cmap"] else { throw FontError() }
        unitsPerEm = Int(Self.u16(bytes, head.0 + 18))
        longLoca = Self.i16(bytes, head.0 + 50) != 0
        numGlyphs = Int(Self.u16(bytes, maxp.0 + 4))
        ascender = Int(Self.i16(bytes, hhea.0 + 4))
        descender = Int(Self.i16(bytes, hhea.0 + 6))
        numberOfHMetrics = Int(Self.u16(bytes, hhea.0 + 34))
        cmap = Self.parseCmap(bytes, cmapTable.0)
    }

    /// Glyph for a scalar; 0 (.notdef) when the font lacks it, as sfnt.GlyphIndex.
    func glyphIndex(_ scalar: Unicode.Scalar) -> Int { cmap[scalar.value] ?? 0 }

    func advance(_ glyph: Int) -> Int {
        guard let hmtx = tables["hmtx"] else { return 0 }
        let index = min(glyph, max(numberOfHMetrics - 1, 0))
        return Int(Self.u16(data, hmtx.offset + index * 4))
    }

    /// Outline contours in font units (y up).
    func contours(_ glyph: Int, depth: Int = 0) -> [Contour] {
        guard depth < 8, glyph >= 0, glyph < numGlyphs, let loca = tables["loca"], let glyf = tables["glyf"] else { return [] }
        let start: Int, end: Int
        if longLoca {
            start = Int(Self.u32(data, loca.offset + glyph * 4)); end = Int(Self.u32(data, loca.offset + glyph * 4 + 4))
        } else {
            start = Int(Self.u16(data, loca.offset + glyph * 2)) * 2; end = Int(Self.u16(data, loca.offset + glyph * 2 + 2)) * 2
        }
        guard end > start else { return [] } // empty glyph (space)
        let base = glyf.offset + start
        guard base + 10 <= data.count else { return [] }
        let contourCount = Int(Self.i16(data, base))
        return contourCount >= 0 ? simple(base, contourCount) : composite(base, depth: depth)
    }

    private func simple(_ base: Int, _ contourCount: Int) -> [Contour] {
        var p = base + 10
        var ends: [Int] = []
        for _ in 0..<contourCount { ends.append(Int(Self.u16(data, p))); p += 2 }
        guard let last = ends.last else { return [] }
        let pointCount = last + 1
        p += 2 + Int(Self.u16(data, p)) // instructions
        var flags: [UInt8] = []
        while flags.count < pointCount, p < data.count {
            let flag = data[p]; p += 1
            flags.append(flag)
            if flag & 0x08 != 0, p < data.count {
                let repeats = Int(data[p]); p += 1
                for _ in 0..<repeats { flags.append(flag) }
            }
        }
        guard flags.count >= pointCount else { return [] }
        func coordinates(short: UInt8, same: UInt8) -> [Int] {
            var value = 0, out: [Int] = []
            for flag in flags.prefix(pointCount) {
                if flag & short != 0 {
                    let delta = Int(data[p]); p += 1
                    value += flag & same != 0 ? delta : -delta
                } else if flag & same == 0 {
                    value += Int(Self.i16(data, p)); p += 2
                }
                out.append(value)
            }
            return out
        }
        let xs = coordinates(short: 0x02, same: 0x10)
        let ys = coordinates(short: 0x04, same: 0x20)
        var contours: [Contour] = []
        var first = 0
        for end in ends {
            guard end >= first, end < pointCount else { break }
            contours.append((first...end).map { (Point(x: Double(xs[$0]), y: Double(ys[$0])), flags[$0] & 0x01 != 0) })
            first = end + 1
        }
        return contours
    }

    private func composite(_ base: Int, depth: Int) -> [Contour] {
        var p = base + 10
        var out: [Contour] = []
        while true {
            let flags = Self.u16(data, p), glyph = Int(Self.u16(data, p + 2)); p += 4
            var dx = 0.0, dy = 0.0
            if flags & 0x0001 != 0 { dx = Double(Self.i16(data, p)); dy = Double(Self.i16(data, p + 2)); p += 4 }
            else { dx = Double(Int8(bitPattern: data[p])); dy = Double(Int8(bitPattern: data[p + 1])); p += 2 }
            var a = 1.0, b = 0.0, c = 0.0, d = 1.0
            func f2dot14(_ at: Int) -> Double { Double(Self.i16(data, at)) / 16384 }
            if flags & 0x0008 != 0 { a = f2dot14(p); d = a; p += 2 }
            else if flags & 0x0040 != 0 { a = f2dot14(p); d = f2dot14(p + 2); p += 4 }
            else if flags & 0x0080 != 0 { a = f2dot14(p); b = f2dot14(p + 2); c = f2dot14(p + 4); d = f2dot14(p + 6); p += 8 }
            if flags & 0x0002 == 0 { dx = 0; dy = 0 } // point-matched components: not used by this font
            for contour in contours(glyph, depth: depth + 1) {
                out.append(contour.map { entry -> (point: Point, onCurve: Bool) in
                    let x: Double = a * entry.point.x + c * entry.point.y + dx
                    let y: Double = b * entry.point.x + d * entry.point.y + dy
                    return (Point(x: x, y: y), entry.onCurve)
                })
            }
            guard flags & 0x0020 != 0 else { break }
        }
        return out
    }

    private static func parseCmap(_ data: [UInt8], _ table: Int) -> [UInt32: Int] {
        var best: (score: Int, offset: Int)?
        for i in 0..<Int(u16(data, table + 2)) {
            let record = table + 4 + i * 8
            let platform = u16(data, record), encoding = u16(data, record + 2)
            let offset = table + Int(u32(data, record + 4))
            let format = u16(data, offset)
            let score = format == 12 && (platform == 3 && encoding == 10 || platform == 0) ? 2
                : format == 4 && (platform == 3 && encoding == 1 || platform == 0) ? 1 : 0
            if score > 0, score > (best?.score ?? 0) { best = (score, offset) }
        }
        guard let offset = best?.offset else { return [:] }
        var map: [UInt32: Int] = [:]
        if u16(data, offset) == 12 {
            for group in 0..<Int(u32(data, offset + 12)) {
                let g = offset + 16 + group * 12
                let startChar = u32(data, g), endChar = u32(data, g + 4), startGlyph = Int(u32(data, g + 8))
                guard endChar >= startChar, endChar - startChar < 0x110000 else { continue }
                for char in startChar...endChar { map[char] = startGlyph + Int(char - startChar) }
            }
        } else {
            let segments = Int(u16(data, offset + 6)) / 2
            let ends = offset + 14, starts = ends + segments * 2 + 2
            let deltas = starts + segments * 2, ranges = deltas + segments * 2
            for s in 0..<segments {
                let end = Int(u16(data, ends + s * 2)), start = Int(u16(data, starts + s * 2))
                let delta = Int(u16(data, deltas + s * 2)), rangeOffset = Int(u16(data, ranges + s * 2))
                guard start <= end, start != 0xFFFF else { continue }
                for char in start...end {
                    var glyph: Int
                    if rangeOffset == 0 { glyph = (char + delta) & 0xFFFF }
                    else {
                        let at = ranges + s * 2 + rangeOffset + (char - start) * 2
                        glyph = Int(u16(data, at)); if glyph != 0 { glyph = (glyph + delta) & 0xFFFF }
                    }
                    if glyph != 0 { map[UInt32(char)] = glyph }
                }
            }
        }
        return map
    }

    private static func u16(_ d: [UInt8], _ at: Int) -> UInt16 { at + 1 < d.count ? UInt16(d[at]) << 8 | UInt16(d[at + 1]) : 0 }
    private static func i16(_ d: [UInt8], _ at: Int) -> Int16 { Int16(bitPattern: u16(d, at)) }
    private static func u32(_ d: [UInt8], _ at: Int) -> UInt32 { UInt32(u16(d, at)) << 16 | UInt32(u16(d, at + 2)) }
}

import Foundation

/// 8-bit RGBA PNG with a self-contained zlib stream (LZ77 + fixed Huffman), so
/// the static binary needs no libz. Terminal images are mostly flat runs and
/// compress well even without dynamic Huffman tables.
enum PNGEncoder {
    static func encode(width: Int, height: Int, rgba: [UInt8]) -> Data {
        precondition(rgba.count == width * height * 4)
        var raw = [UInt8]()
        raw.reserveCapacity((width * 4 + 1) * height)
        for y in 0..<height {
            raw.append(0) // filter: none
            raw.append(contentsOf: rgba[(y * width * 4)..<((y + 1) * width * 4)])
        }
        var png: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        var header = [UInt8]()
        header += bigEndian(UInt32(width)) + bigEndian(UInt32(height))
        header += [8, 6, 0, 0, 0] // 8-bit, RGBA, deflate, adaptive filtering, no interlace
        chunk("IHDR", header, into: &png)
        chunk("IDAT", zlib(raw), into: &png)
        chunk("IEND", [], into: &png)
        return Data(png)
    }

    private static func bigEndian(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8(v >> 16 & 0xff), UInt8(v >> 8 & 0xff), UInt8(v & 0xff)] }

    private static func chunk(_ type: String, _ body: [UInt8], into png: inout [UInt8]) {
        let typed = Array(type.utf8) + body
        png += bigEndian(UInt32(body.count)) + typed + bigEndian(crc32(typed))
    }

    private static let crcTable: [UInt32] = (0..<256).map { n in
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1 }
        return c
    }

    private static func crc32(_ bytes: [UInt8]) -> UInt32 {
        var c: UInt32 = 0xFFFFFFFF
        for b in bytes { c = crcTable[Int((c ^ UInt32(b)) & 0xff)] ^ (c >> 8) }
        return c ^ 0xFFFFFFFF
    }

    private static func zlib(_ data: [UInt8]) -> [UInt8] {
        var a: UInt32 = 1, b: UInt32 = 0
        for (i, byte) in data.enumerated() {
            a &+= UInt32(byte); b &+= a
            if i % 5552 == 5551 { a %= 65521; b %= 65521 }
        }
        a %= 65521; b %= 65521
        return [0x78, 0x01] + deflate(data) + bigEndian(b << 16 | a)
    }

    // MARK: Deflate (RFC 1951), one fixed-Huffman block

    private struct BitWriter {
        var bytes: [UInt8] = []
        var accumulator: UInt64 = 0, count = 0
        mutating func write(_ value: UInt32, _ bits: Int) {
            accumulator |= UInt64(value) << UInt64(count); count += bits
            while count >= 8 { bytes.append(UInt8(accumulator & 0xff)); accumulator >>= 8; count -= 8 }
        }
        /// Huffman codes are packed most-significant bit first.
        mutating func writeCode(_ code: UInt32, _ bits: Int) {
            var reversed: UInt32 = 0
            for i in 0..<bits { reversed |= ((code >> UInt32(i)) & 1) << UInt32(bits - 1 - i) }
            write(reversed, bits)
        }
        mutating func flush() { if count > 0 { bytes.append(UInt8(accumulator & 0xff)); accumulator = 0; count = 0 } }
    }

    private static let lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
    private static let lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
    private static let distanceBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
                                       4097, 6145, 8193, 12289, 16385, 24577]
    private static let distanceExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

    private static func literal(_ value: Int, _ out: inout BitWriter) {
        switch value {
        case 0...143: out.writeCode(UInt32(0x30 + value), 8)
        case 144...255: out.writeCode(UInt32(0x190 + value - 144), 9)
        case 256...279: out.writeCode(UInt32(value - 256), 7)
        default: out.writeCode(UInt32(0xC0 + value - 280), 8)
        }
    }

    private static func deflate(_ data: [UInt8]) -> [UInt8] {
        var out = BitWriter()
        out.write(1, 1) // final block
        out.write(1, 2) // fixed Huffman
        let window = 32768, hashSize = 1 << 15
        var head = [Int](repeating: -1, count: hashSize)
        var previous = [Int](repeating: -1, count: window)
        func hash(_ i: Int) -> Int { (Int(data[i]) << 10 ^ Int(data[i + 1]) << 5 ^ Int(data[i + 2])) & (hashSize - 1) }
        func insert(_ i: Int) {
            guard i + 2 < data.count else { return }
            let h = hash(i)
            previous[i % window] = head[h]; head[h] = i
        }
        var i = 0
        while i < data.count {
            var bestLength = 0, bestDistance = 0
            if i + 2 < data.count {
                var candidate = head[hash(i)], chain = 0
                while candidate >= 0, i - candidate <= window, chain < 64 {
                    var length = 0
                    let limit = min(258, data.count - i)
                    while length < limit, data[candidate + length] == data[i + length] { length += 1 }
                    if length > bestLength { bestLength = length; bestDistance = i - candidate; if length == limit { break } }
                    let next = previous[candidate % window]
                    if next >= candidate { break }
                    candidate = next; chain += 1
                }
            }
            if bestLength >= 3 {
                let lengthCode = lengthBase.lastIndex { $0 <= bestLength }!
                literal(257 + lengthCode, &out)
                if lengthExtra[lengthCode] > 0 { out.write(UInt32(bestLength - lengthBase[lengthCode]), lengthExtra[lengthCode]) }
                let distanceCode = distanceBase.lastIndex { $0 <= bestDistance }!
                out.writeCode(UInt32(distanceCode), 5)
                if distanceExtra[distanceCode] > 0 { out.write(UInt32(bestDistance - distanceBase[distanceCode]), distanceExtra[distanceCode]) }
                for j in i..<(i + bestLength) { insert(j) }
                i += bestLength
            } else {
                literal(Int(data[i]), &out)
                insert(i)
                i += 1
            }
        }
        literal(256, &out) // end of block
        out.flush()
        return out.bytes
    }
}

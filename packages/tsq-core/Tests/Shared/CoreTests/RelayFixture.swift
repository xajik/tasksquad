import Foundation
@testable import TaskSquadCore

/// A TerminalRelay Durable Object double: accepts the daemon's WebSocket on
/// /terminal/<session>, records its headers and binary frames, and can push
/// browser frames back. Plain POSIX sockets and RFC 6455 framing, so the same
/// fixture runs on macOS and Linux.
final class RelayFixture: @unchecked Sendable {
    private let lock = NSLock()
    private let listenFD: Int32
    private var clients: [Int32] = []
    private var received = Data()
    private var headers: [String: String] = [:]
    private var stopped = false
    let port: UInt16

    init() throws {
        let fd = socket(AF_INET, Self.streamType, 0)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(fd, 16) == 0 else { close(fd); throw POSIXError(.EADDRINUSE) }
        var actual = sockaddr_in(), length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        listenFD = fd
        port = UInt16(bigEndian: actual.sin_port)
        Thread { [self] in acceptLoop() }.start()
    }

    #if canImport(Glibc)
    private static let streamType = Int32(SOCK_STREAM.rawValue)
    #else
    private static let streamType = SOCK_STREAM
    #endif

    var bytes: Data { lock.withLock { received } }
    var connectionCount: Int { lock.withLock { clients.count } }
    /// Headers of the (latest) upgrade request.
    var firstHeaders: [String: String] { lock.withLock { headers } }

    /// Sends a browser frame (JSON text) to every connected daemon socket.
    func send(_ text: String) {
        let frame = Self.frame(opcode: 0x1, payload: Data(text.utf8))
        for fd in lock.withLock({ clients }) { Self.writeAll(fd, frame) }
    }

    func stop() {
        let fds = lock.withLock { () -> [Int32] in stopped = true; return clients }
        shutdown(listenFD, Int32(SHUT_RDWR)); close(listenFD)
        for fd in fds { shutdown(fd, Int32(SHUT_RDWR)) }
    }

    private func acceptLoop() {
        while true {
            let fd = accept(listenFD, nil, nil)
            if fd < 0 { if errno == EINTR { continue }; return }
            guard lock.withLock({ () -> Bool in if stopped { return false }; clients.append(fd); return true }) else { close(fd); return }
            Thread { [self] in serve(fd) }.start()
        }
    }

    private func serve(_ fd: Int32) {
        defer { lock.withLock { clients.removeAll { $0 == fd } }; close(fd) }
        var buffer = Data()
        // Upgrade request.
        while buffer.range(of: Data("\r\n\r\n".utf8)) == nil {
            guard let chunk = Self.readSome(fd) else { return }
            buffer.append(chunk)
        }
        let end = buffer.range(of: Data("\r\n\r\n".utf8))!
        let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
        buffer = Data(buffer[end.upperBound...])
        var parsed: [String: String] = [:]
        for line in head.components(separatedBy: "\r\n").dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            parsed[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        lock.withLock { headers = parsed }
        let accept = Data(Self.sha1(Array(((parsed["sec-websocket-key"] ?? "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
        Self.writeAll(fd, Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8))
        // Frames.
        while true {
            while Self.frameLength(buffer) == nil {
                guard let chunk = Self.readSome(fd) else { return }
                buffer.append(chunk)
            }
            let (opcode, payload, consumed) = Self.parse(buffer)
            buffer = Data(buffer.dropFirst(consumed))
            switch opcode {
            case 0x2: lock.withLock { received.append(payload) }
            case 0x9: Self.writeAll(fd, Self.frame(opcode: 0xA, payload: payload))
            case 0x8: Self.writeAll(fd, Self.frame(opcode: 0x8, payload: payload.prefix(2))); return
            default: break
            }
        }
    }

    // MARK: RFC 6455

    /// Total length of the first complete frame in `data`, or nil while incomplete.
    private static func frameLength(_ data: Data) -> Int? {
        let b = [UInt8](data.prefix(14))
        guard b.count >= 2 else { return nil }
        var length = Int(b[1] & 0x7f), header = 2
        if length == 126 { guard b.count >= 4 else { return nil }; length = Int(b[2]) << 8 | Int(b[3]); header = 4 }
        else if length == 127 { guard b.count >= 10 else { return nil }; length = b[2..<10].reduce(0) { $0 << 8 | Int($1) }; header = 10 }
        let total = header + (b[1] & 0x80 != 0 ? 4 : 0) + length
        return data.count >= total ? total : nil
    }

    private static func parse(_ data: Data) -> (opcode: UInt8, payload: Data, consumed: Int) {
        let b = [UInt8](data)
        var length = Int(b[1] & 0x7f), offset = 2
        if length == 126 { length = Int(b[2]) << 8 | Int(b[3]); offset = 4 }
        else if length == 127 { length = b[2..<10].reduce(0) { $0 << 8 | Int($1) }; offset = 10 }
        var mask: [UInt8] = []
        if b[1] & 0x80 != 0 { mask = Array(b[offset..<offset + 4]); offset += 4 }
        var payload = Array(b[offset..<offset + length])
        if !mask.isEmpty { for i in payload.indices { payload[i] ^= mask[i % 4] } }
        return (b[0] & 0x0f, Data(payload), offset + length)
    }

    /// An unmasked server frame.
    private static func frame(opcode: UInt8, payload: Data) -> Data {
        var out: [UInt8] = [0x80 | opcode]
        if payload.count < 126 { out.append(UInt8(payload.count)) }
        else if payload.count <= 0xffff { out += [126, UInt8(payload.count >> 8), UInt8(payload.count & 0xff)] }
        else { out.append(127); for shift in stride(from: 56, through: 0, by: -8) { out.append(UInt8((payload.count >> shift) & 0xff)) } }
        return Data(out) + payload
    }

    private static func readSome(_ fd: Int32) -> Data? {
        var bytes = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = read(fd, &bytes, bytes.count)
            if count > 0 { return Data(bytes[0..<count]) }
            if count < 0 && errno == EINTR { continue }
            return nil
        }
    }

    private static func writeAll(_ fd: Int32, _ data: Data) {
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count > 0 { offset += count } else if count < 0 && errno == EINTR { continue } else { return }
            }
        }
    }

    /// SHA-1 for Sec-WebSocket-Accept (no crypto dependency in the test target).
    private static func sha1(_ message: [UInt8]) -> [UInt8] {
        var h: [UInt32] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]
        var data = message + [0x80]
        while data.count % 64 != 56 { data.append(0) }
        let bits = UInt64(message.count) * 8
        for shift in stride(from: 56, through: 0, by: -8) { data.append(UInt8((bits >> UInt64(shift)) & 0xff)) }
        func rotl(_ x: UInt32, _ n: UInt32) -> UInt32 { x << n | x >> (32 - n) }
        for chunk in stride(from: 0, to: data.count, by: 64) {
            var w = (0..<16).map { i in data[chunk + i * 4..<chunk + i * 4 + 4].reduce(UInt32(0)) { $0 << 8 | UInt32($1) } }
            for i in 16..<80 { w.append(rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)) }
            var (a, b, c, d, e) = (h[0], h[1], h[2], h[3], h[4])
            for i in 0..<80 {
                let (f, k): (UInt32, UInt32) = i < 20 ? ((b & c) | (~b & d), 0x5A827999) : i < 40 ? (b ^ c ^ d, 0x6ED9EBA1)
                    : i < 60 ? ((b & c) | (b & d) | (c & d), 0x8F1BBCDC) : (b ^ c ^ d, 0xCA62C1D6)
                let t = rotl(a, 5) &+ f &+ e &+ k &+ w[i]
                (e, d, c, b, a) = (d, c, rotl(b, 30), a, t)
            }
            h = [h[0] &+ a, h[1] &+ b, h[2] &+ c, h[3] &+ d, h[4] &+ e]
        }
        return h.flatMap { v in [24, 16, 8, 0].map { UInt8((v >> $0) & 0xff) } }
    }
}

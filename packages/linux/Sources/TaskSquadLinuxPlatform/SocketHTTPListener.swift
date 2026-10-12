import Foundation
import Dispatch
import TaskSquadCore

/// Loopback listener on POSIX sockets + Dispatch (no NIO): 127.0.0.1 only, one
/// request per connection, with the same client cap and deadline as the macOS
/// NWListener. Decoding and responses are core's (HTTPRequestDecoder,
/// LocalHTTPResponse.encoded); this only moves bytes.
final class SocketHTTPListener: LocalHTTPListener, @unchecked Sendable {
    private let port: UInt16
    private let bodyLimit: Int
    private let handler: LocalHTTPServer.Handler
    private let queue = DispatchQueue(label: "ai.tasksquad.local-http")
    // Mutable state below is touched only on `queue`.
    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?
    private var clients: [Int32: Client] = [:]
    private var started = false
    private var stopped = false

    private final class Client: @unchecked Sendable { // confined to `queue`
        let fd: Int32
        var buffer = Data()
        let state = HTTPDecodeState()
        var source: DispatchSourceRead?
        var deadline: DispatchWorkItem?
        var responding = false
        init(fd: Int32) { self.fd = fd }
    }

    init(port: UInt16, bodyLimit: Int, handler: @escaping LocalHTTPServer.Handler) {
        self.port = port; self.bodyLimit = bodyLimit; self.handler = handler
    }

    deinit { if listenFD >= 0 { close(listenFD) } }

    func start() async throws -> UInt16 {
        try queue.sync {
            guard !started else { throw ConfigurationError("HTTP listener already started") }
            started = true
            let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue) | Int32(SOCK_CLOEXEC.rawValue), 0)
            guard fd >= 0 else { throw Self.posixError() }
            var reuse: Int32 = 1 // as Go's net.Listen
            _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
            var address = sockaddr_in()
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = port.bigEndian
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
            }
            guard bound == 0, listen(fd, 128) == 0 else { let error = Self.posixError(); close(fd); throw error }
            var actual = sockaddr_in(), length = socklen_t(MemoryLayout<sockaddr_in>.size)
            _ = withUnsafeMutablePointer(to: &actual) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
            }
            _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
            listenFD = fd
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler { [weak self] in self?.acceptPending() }
            source.resume()
            acceptSource = source
            return UInt16(bigEndian: actual.sin_port)
        }
    }

    func stop() async {
        queue.sync {
            stopped = true
            acceptSource?.cancel(); acceptSource = nil
            if listenFD >= 0 { close(listenFD); listenFD = -1 }
            for client in clients.values { finish(client) }
        }
    }

    private func acceptPending() {
        while true {
            let fd = accept4(listenFD, nil, nil, Int32(SOCK_CLOEXEC.rawValue) | Int32(SOCK_NONBLOCK.rawValue))
            guard fd >= 0 else { return } // EAGAIN: drained
            guard !stopped, clients.count < LocalHTTPServer.maxClients else { close(fd); continue }
            let client = Client(fd: fd)
            clients[fd] = client
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler { [weak self, weak client] in if let self, let client { self.readAvailable(client) } }
            client.source = source
            let deadline = DispatchWorkItem { [weak self, weak client] in if let self, let client { self.finish(client) } }
            client.deadline = deadline
            let seconds = Double(LocalHTTPServer.connectionDeadline.components.seconds)
            queue.asyncAfter(deadline: .now() + seconds, execute: deadline)
            source.resume()
        }
    }

    private func readAvailable(_ client: Client) {
        guard !client.responding else { return }
        var bytes = [UInt8](repeating: 0, count: 64 * 1024)
        var closed = false
        while true {
            let count = read(client.fd, &bytes, bytes.count)
            if count > 0 { client.buffer.append(contentsOf: bytes[0..<count]); continue }
            if count == 0 { closed = true }
            else if errno == EINTR { continue }
            else if errno != EAGAIN && errno != EWOULDBLOCK { finish(client); return }
            break
        }
        do {
            if let request = try HTTPRequestDecoder.decode(client.buffer, bodyLimit: bodyLimit, state: client.state) {
                respond(client) { [handler] in await handler(request) }
            } else if closed { respond(client) { LocalHTTPResponse(status: 400) } }
        } catch let error as HTTPError { respond(client) { LocalHTTPResponse(status: error.status) } }
        catch { respond(client) { LocalHTTPResponse(status: 400) } }
    }

    private func respond(_ client: Client, _ make: @escaping @Sendable () async -> LocalHTTPResponse) {
        client.responding = true
        client.source?.suspend()
        let fd = client.fd
        Task {
            let response = await make()
            queue.async { [weak self] in
                guard let self, self.clients[fd] === client else { return }
                // Small responses on loopback: write synchronously, retrying partial writes.
                _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
                let data = response.encoded
                data.withUnsafeBytes { raw in
                    guard let base = raw.baseAddress else { return }
                    var offset = 0
                    while offset < raw.count {
                        let count = write(fd, base.advanced(by: offset), raw.count - offset)
                        if count > 0 { offset += count } else if count < 0 && errno == EINTR { continue } else { break }
                    }
                }
                response.onSent?()
                self.finish(client)
            }
        }
    }

    private func finish(_ client: Client) {
        guard clients.removeValue(forKey: client.fd) != nil else { return }
        client.deadline?.cancel()
        if let source = client.source {
            if client.responding { source.resume() } // a suspended source must be resumed before cancel
            source.setCancelHandler { close(client.fd) }
            source.cancel()
        } else {
            close(client.fd)
        }
    }

    private static func posixError() -> POSIXError { POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
}

import Foundation
import TaskSquadCore
#if canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

/// Linux services for the shared engine and CLI, each matching what the Go daemon
/// does on Linux. Install before anything else runs: `Platform.install(LinuxPlatform())`.
public struct LinuxPlatform: PlatformServices {
    public init() {
        // Go's runtime turns SIGPIPE on a non-stdio descriptor into EPIPE. Linux has no
        // per-descriptor F_SETNOSIGPIPE, so ignore it process-wide; writers handle EPIPE.
        signal(SIGPIPE, SIG_IGN)
    }

    public func runProcess(_ specification: ProcessSpecification,
                           output: @escaping @Sendable (ProcessChannel, Data) async throws -> Void,
                           started: @Sendable (pid_t) async -> Void) async throws -> ProcessExit {
        try await LinuxProcess.run(specification, output: output, started: started)
    }

    public func makeHTTPListener(port: UInt16, bodyLimit: Int, handler: @escaping LocalHTTPServer.Handler) throws -> any LocalHTTPListener {
        SocketHTTPListener(port: port, bodyLimit: bodyLimit, handler: handler)
    }

    public func credentialStore(service: String) -> any CredentialStore { SecretServiceCredentialStore(service: service) }

    public func renderScreenshot(_ grid: [[TerminalScreenshot.Cell]]) throws -> Data {
        // TODO(linux): port Go's PNG renderer (packages/daemon/screenshot); Go renders on Linux too.
        throw ConfigurationError("terminal screenshots are not supported on Linux yet")
    }

    public func dialWebSocket(_ request: URLRequest) -> (any WebSocketConnection)? { URLSessionWebSocket(request: request) }

    public func autostart(home: URL) -> any Autostart { XDGAutostart(home: home) }
    public func makeWakeLock() -> any WakeLock { SystemdInhibitWakeLock() }
    /// Go auth.openBrowser on Linux.
    public func browserCommand(for url: URL) -> (executable: String, arguments: [String]) { ("xdg-open", [url.absoluteString]) }

    /// go-keyring Get(service, "id-token") through the Secret Service.
    public func hasStoredIDToken(environment: [String: String]) async -> Bool {
        let value = try? SecretServiceCredentialStore(service: CredentialService.daemon, environment: environment).read(.idToken)
        return !(value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Go's os.UserConfigDir: $XDG_CONFIG_HOME when set (and absolute), else ~/.config.
    public func userConfigDirectory(home: URL) -> URL {
        if let configured = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"], configured.hasPrefix("/") {
            return URL(fileURLWithPath: configured, isDirectory: true)
        }
        return home.appendingPathComponent(".config", isDirectory: true)
    }
}

/// URLSessionWebSocketTask (FoundationNetworking, libcurl). Unlike Apple's, it
/// fails sends made before the upgrade completes instead of queueing them, so
/// send/receive first wait for the open handshake (as Go's websocket.Dial returns
/// only once connected). Text frames arrive as their UTF-8 bytes.
final class URLSessionWebSocket: NSObject, WebSocketConnection, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var opened: Bool? // nil while connecting
    private var waiters: [CheckedContinuation<Void, Error>] = []

    init(request: URLRequest) {
        super.init()
        // The session retains its delegate until close() invalidates it.
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        lock.withLock { self.session = session; self.task = task }
        task.resume()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) { settle(true) }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) { settle(false) }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) { settle(false) }

    private func settle(_ open: Bool) {
        let ready = lock.withLock { () -> [CheckedContinuation<Void, Error>] in
            if opened == nil || !open { opened = open }
            defer { waiters = [] }
            return waiters
        }
        for waiter in ready { open ? waiter.resume() : waiter.resume(throwing: URLError(.networkConnectionLost)) }
    }

    private func connected() async throws -> URLSessionWebSocketTask {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let state = lock.withLock { () -> Bool? in
                if opened == nil { waiters.append(continuation) }
                return opened
            }
            switch state {
            case .some(true): continuation.resume()
            case .some(false): continuation.resume(throwing: URLError(.networkConnectionLost))
            case .none: break
            }
        }
        guard let task = lock.withLock({ task }) else { throw URLError(.cancelled) }
        return task
    }

    func send(_ data: Data) async throws { try await connected().send(.data(data)) }

    func receive() async throws -> Data {
        switch try await connected().receive() {
        case .string(let text): Data(text.utf8)
        case .data(let bytes): bytes
        @unknown default: Data()
        }
    }

    func close() {
        let (task, session) = lock.withLock { (self.task, self.session) }
        task?.cancel(with: .normalClosure, reason: nil)
        session?.finishTasksAndInvalidate()
        settle(false)
    }
}

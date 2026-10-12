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

    public func screenshot(session: String, scrollbackLines: Int, tmux: TmuxConnection) async throws -> Data {
        // TODO(linux): port Go's PNG renderer (packages/daemon/screenshot); Go renders on Linux too.
        throw ConfigurationError("terminal screenshots are not supported on Linux yet")
    }

    public func dialWebSocket(_ request: URLRequest) -> (any WebSocketConnection)? {
        let task = URLSession.shared.webSocketTask(with: request)
        task.resume()
        return URLSessionWebSocket(task: task)
    }

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

/// URLSessionWebSocketTask (FoundationNetworking on Linux); text frames arrive as their UTF-8 bytes.
final class URLSessionWebSocket: WebSocketConnection, @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    init(task: URLSessionWebSocketTask) { self.task = task }
    func send(_ data: Data) async throws { try await task.send(.data(data)) }
    func receive() async throws -> Data {
        switch try await task.receive() {
        case .string(let text): Data(text.utf8)
        case .data(let bytes): bytes
        @unknown default: Data()
        }
    }
    func close() { task.cancel(with: .normalClosure, reason: nil) }
}

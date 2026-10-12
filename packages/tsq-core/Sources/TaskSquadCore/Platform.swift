import Foundation

/// The OS services the shared engine and CLI need. Everything here behaves
/// differently per OS; everything else in TaskSquadCore is the same source on
/// macOS and Linux. Each OS layer installs one implementation at launch, before
/// any engine or CLI code runs (`Platform.install(MacPlatform())`).
public protocol PlatformServices: Sendable {
    /// Spawns a child with byte-preserving argv/env and no fds leaked into it.
    func runProcess(_ specification: ProcessSpecification,
                    output: @escaping @Sendable (ProcessChannel, Data) async throws -> Void,
                    started: @Sendable (pid_t) async -> Void) async throws -> ProcessExit
    /// A loopback listener; it decodes with `HTTPRequestDecoder` and writes
    /// `LocalHTTPResponse.encoded`, so request handling stays in core.
    func makeHTTPListener(port: UInt16, bodyLimit: Int, handler: @escaping LocalHTTPServer.Handler) throws -> any LocalHTTPListener
    /// The OS secret store Go's go-keyring uses for the same service name.
    func credentialStore(service: String) -> any CredentialStore
    /// Rasterizes a captured pane to PNG in Go's cells (packages/daemon/screenshot render.go).
    func renderScreenshot(_ grid: [[TerminalScreenshot.Cell]]) throws -> Data
    /// An open WebSocket, or nil when it can't be created.
    func dialWebSocket(_ request: URLRequest) -> (any WebSocketConnection)?
    /// Run-on-login registration for the headless daemon.
    func autostart(home: URL) -> any Autostart
    func makeWakeLock() -> any WakeLock
    /// The command that opens a URL in the user's browser.
    func browserCommand(for url: URL) -> (executable: String, arguments: [String])
    /// Go's auth.IsLoggedIn: an ID token is stored, read without any UI prompt.
    func hasStoredIDToken(environment: [String: String]) async -> Bool
    /// Go's os.UserConfigDir.
    func userConfigDirectory(home: URL) -> URL
}

public protocol LocalHTTPListener: Sendable {
    /// Starts listening on 127.0.0.1 and returns the bound port.
    func start() async throws -> UInt16
    func stop() async
}

public protocol WebSocketConnection: Sendable {
    func send(_ data: Data) async throws
    /// The next message's bytes (text frames as UTF-8); throws once closed.
    func receive() async throws -> Data
    /// Normal closure.
    func close()
}

public enum Platform {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var installed: (any PlatformServices)?

    public static func install(_ services: any PlatformServices) {
        lock.withLock { installed = services }
    }

    public static var current: any PlatformServices {
        guard let services = lock.withLock({ installed }) else {
            fatalError("TaskSquad platform services not installed: call Platform.install at launch")
        }
        return services
    }
}

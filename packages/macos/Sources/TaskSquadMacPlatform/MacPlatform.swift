import Foundation
import TaskSquadCore

/// macOS services for the shared engine and CLI. Install before anything else
/// runs: `Platform.install(MacPlatform())`.
public struct MacPlatform: PlatformServices {
    public init() {}

    public func runProcess(_ specification: ProcessSpecification,
                           output: @escaping @Sendable (ProcessChannel, Data) async throws -> Void,
                           started: @Sendable (pid_t) async -> Void) async throws -> ProcessExit {
        try await MacProcess.run(specification, output: output, started: started)
    }

    public func makeHTTPListener(port: UInt16, bodyLimit: Int, handler: @escaping LocalHTTPServer.Handler) throws -> any LocalHTTPListener {
        try NWHTTPListener(port: port, bodyLimit: bodyLimit, handler: handler)
    }

    public func credentialStore(service: String) -> any CredentialStore { KeychainCredentialStore(service: service) }

    public func renderScreenshot(_ grid: [[TerminalScreenshot.Cell]]) throws -> Data { try MacTerminalScreenshot.render(grid) }

    public func dialWebSocket(_ request: URLRequest) -> (any WebSocketConnection)? {
        let task = URLSession.shared.webSocketTask(with: request)
        task.resume()
        return URLSessionWebSocket(task: task)
    }

    public func autostart(home: URL) -> any Autostart { LaunchAgent(home: home) }
    public func makeWakeLock() -> any WakeLock { CaffeinateWakeLock() }
    public func browserCommand(for url: URL) -> (executable: String, arguments: [String]) { ("/usr/bin/open", [url.absoluteString]) }

    /// Like go-keyring on macOS: `security find-generic-password` (never blocks on Keychain UI from a tool).
    public func hasStoredIDToken(environment: [String: String]) async -> Bool {
        let output = KeychainProbe()
        let status = try? await NativeProcess.run(.init(executable: "/usr/bin/security",
            arguments: ["find-generic-password", "-s", CredentialService.daemon, "-wa", CredentialKey.idToken.rawValue], environment: environment)) { channel, data in
            if channel == .stdout { await output.append(data) }
        }
        let text = await output.text
        return status?.code == 0 && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public func userConfigDirectory(home: URL) -> URL { home.appendingPathComponent("Library/Application Support") }
}

private actor KeychainProbe {
    var data = Data()
    func append(_ chunk: Data) { data.append(chunk) }
    var text: String { String(decoding: data, as: UTF8.self) }
}

/// URLSessionWebSocketTask; text frames arrive as their UTF-8 bytes.
final class URLSessionWebSocket: WebSocketConnection {
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

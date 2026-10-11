import Combine
import Foundation

/// Shared interactive terminal transport used by the macOS and iOS Portal views.
/// The caller supplies authenticated ticket and URL builders so credentials never
/// travel in the WebSocket URL; the Worker ticket is single-use and expires quickly.
@MainActor
public final class PortalTerminalSession: ObservableObject {
    public typealias TicketProvider = @Sendable (_ sessionID: String) async throws -> String
    public typealias SocketURLProvider = @Sendable (_ sessionID: String, _ ticket: String, _ replay: Bool) throws -> URL

    @Published public private(set) var status = "Connecting…"
    @Published public private(set) var connected = false
    public var onOutput: (@MainActor @Sendable (Data) -> Void)?

    public let sessionID: String
    private let ticketProvider: TicketProvider
    private let socketURLProvider: SocketURLProvider
    private var socket: URLSessionWebSocketTask?
    private var connectionID = UUID()
    private var pendingBytes = 0
    private var sendTask: Task<Void, Never>?
    private var cols = 100
    private var rows = 30
    private var everConnected = false

    public init(sessionID: String, ticketProvider: @escaping TicketProvider,
                socketURLProvider: @escaping SocketURLProvider) {
        self.sessionID = sessionID
        self.ticketProvider = ticketProvider
        self.socketURLProvider = socketURLProvider
    }

    public func connect() async {
        disconnect()
        let id = connectionID
        var failures = 0
        while !Task.isCancelled, connectionID == id {
            do {
                status = failures == 0 ? "Connecting…" : "Reconnecting…"
                let ticket = try await ticketProvider(sessionID)
                guard !ticket.isEmpty else { throw URLError(.badServerResponse) }
                let url = try socketURLProvider(sessionID, ticket, !everConnected)
                guard !Task.isCancelled, connectionID == id else { return }
                let candidate = URLSession.shared.webSocketTask(with: url)
                candidate.maximumMessageSize = 4 * 1024 * 1024
                socket = candidate
                candidate.resume()
                try await candidate.send(.data(Self.resizeFrame(cols: cols, rows: rows)))
                guard !Task.isCancelled, connectionID == id else {
                    candidate.cancel(with: .goingAway, reason: nil)
                    return
                }
                connected = true
                status = "Connected"
                everConnected = true
                while !Task.isCancelled, connectionID == id {
                    let message = try await candidate.receive()
                    guard connectionID == id else { return }
                    failures = 0
                    if case .data(let data) = message { onOutput?(data) }
                }
            } catch {
                guard !Task.isCancelled, connectionID == id else { return }
                connected = false
                socket?.cancel(with: .goingAway, reason: nil)
                socket = nil
                if let apiError = error as? CustomerAPIError, [401, 403, 404].contains(apiError.status) {
                    status = apiError.message
                    return
                }
                failures += 1
                guard failures <= 6 else {
                    status = "Connection lost. Reconnect to try again."
                    return
                }
                let seconds = min(pow(2, Double(failures - 1)), 30)
                status = "Connection lost · retrying in \(Int(seconds))s"
                do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            }
        }
    }

    public func input(_ data: Data) { send(Self.inputFrame(data)) }

    public func resize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        self.cols = cols
        self.rows = rows
        send(Self.resizeFrame(cols: cols, rows: rows))
    }

    public func disconnect() {
        connectionID = UUID()
        connected = false
        sendTask?.cancel()
        sendTask = nil
        pendingBytes = 0
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
    }

    private func send(_ data: Data) {
        guard connected, let socket else { return }
        guard pendingBytes + data.count <= 64 * 1024 else { status = "Input buffer full. Wait before sending more."; return }
        pendingBytes += data.count
        let previous = sendTask
        let id = connectionID
        sendTask = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled, self?.connectionID == id else { return }
            defer { if self?.connectionID == id { self?.pendingBytes -= data.count } }
            do { try await socket.send(.data(data)) }
            catch { socket.cancel(with: .goingAway, reason: nil) }
        }
    }

    nonisolated public static func inputFrame(_ data: Data) -> Data {
        let encoded = data.base64EncodedString()
        return Data("{\"t\":\"i\",\"d\":\"\(encoded)\"}".utf8)
    }

    nonisolated public static func resizeFrame(cols: Int, rows: Int) -> Data {
        Data("{\"t\":\"r\",\"c\":\(cols),\"r\":\(rows)}".utf8)
    }
}

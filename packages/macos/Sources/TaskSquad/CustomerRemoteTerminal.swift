import AppKit
import SwiftUI
@preconcurrency import SwiftTerm
import TaskSquadCore

/// Uses the same single-use tickets and binary input/resize frames as the web
/// portal. SwiftTerm supplies an AppKit renderer and VT parser, not a WebView.
@MainActor final class CustomerTerminalModel: ObservableObject {
    @Published var status = "Connecting…"
    @Published var connected = false
    var output: ((Data) -> Void)?
    private var socket: URLSessionWebSocketTask?
    private var connectionID = UUID()
    private var sendTask: Task<Void, Never>?
    private var cols = 100, rows = 30
    private var everConnected = false

    func run(api: CustomerAPI, sessionID: String) async {
        disconnect()
        let id = connectionID
        var failures = 0
        while !Task.isCancelled, connectionID == id {
            do {
                status = failures == 0 ? "Connecting…" : "Reconnecting…"
                let response = try await api.request(["terminal", "ticket"], method: "POST", body: .object(["session_id": .string(sessionID)]))
                guard let ticket = response["ticket"]?.string, !ticket.isEmpty else { throw URLError(.badServerResponse) }
                var url = URLComponents(url: try api.url(["terminal", sessionID], query: ["ticket": ticket, "replay": everConnected ? "0" : "1"]), resolvingAgainstBaseURL: false)!
                url.scheme = url.scheme == "https" ? "wss" : "ws"
                guard !Task.isCancelled, connectionID == id else { return }
                let candidate = URLSession.shared.webSocketTask(with: url.url!)
                candidate.maximumMessageSize = 4 * 1024 * 1024
                socket = candidate; candidate.resume()
                try await candidate.send(.data(Self.resizeFrame(cols: cols, rows: rows)))
                guard !Task.isCancelled, connectionID == id else { candidate.cancel(with: .goingAway, reason: nil); return }
                connected = true; status = "Connected"; everConnected = true
                while !Task.isCancelled, connectionID == id {
                    let message = try await candidate.receive()
                    guard connectionID == id else { return }
                    failures = 0
                    if case .data(let data) = message { output?(data) }
                    // Text frames are relay keepalives, not terminal output.
                }
            } catch {
                guard !Task.isCancelled, connectionID == id else { return }
                connected = false; socket?.cancel(with: .goingAway, reason: nil); socket = nil
                if let apiError = error as? CustomerAPIError, [401, 403, 404].contains(apiError.status) {
                    status = apiError.localizedDescription; return
                }
                failures += 1
                guard failures <= 6 else { status = "Connection lost. Reconnect to try again."; return }
                let seconds = min(pow(2, Double(failures - 1)), 30)
                status = "Connection lost · retrying in \(Int(seconds))s"
                do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            }
        }
    }
    func input(_ data: Data) { send(Self.inputFrame(data)) }
    func resize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        self.cols = cols; self.rows = rows
        send(Self.resizeFrame(cols: cols, rows: rows))
    }
    private func send(_ data: Data) {
        guard connected, let socket else { return }
        let previous = sendTask, id = connectionID
        // Keep keystrokes and resize frames in order, including multi-byte paste.
        sendTask = Task { [weak self] in
            await previous?.value
            guard !Task.isCancelled, self?.connectionID == id else { return }
            do { try await socket.send(.data(data)) }
            catch { socket.cancel(with: .goingAway, reason: nil) }
        }
    }
    func disconnect() {
        connectionID = UUID(); connected = false
        sendTask?.cancel(); sendTask = nil
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
    }
    static func inputFrame(_ data: Data) -> Data {
        // Input is bytes, avoiding btoa's Unicode limitation in browsers.
        try! JSONEncoder().encode(JSONValue.object(["t": .string("i"), "d": .string(data.base64EncodedString())]))
    }
    static func resizeFrame(cols: Int, rows: Int) -> Data {
        try! JSONEncoder().encode(JSONValue.object(["t": .string("r"), "c": .number(Double(cols)), "r": .number(Double(rows))]))
    }
}

struct CustomerRemoteTerminal: View {
    let api: CustomerAPI?
    let sessionID: String
    @StateObject private var model = CustomerTerminalModel()
    @State private var attempt = UUID()
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Circle().fill(model.connected ? Color.green : Color.orange).frame(width: 6, height: 6)
                Text(model.status).font(.caption)
                Spacer(); Button("Reconnect") { model.disconnect(); attempt = UUID() }
            }.padding(8)
            CustomerTerminalView(model: model)
        }
        .task(id: attempt) { if let api { await model.run(api: api, sessionID: sessionID) } }
        .onDisappear { model.disconnect() }
    }
}

private struct CustomerTerminalView: NSViewRepresentable {
    let model: CustomerTerminalModel
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeNSView(context: Context) -> SwiftTerm.TerminalView {
        let view = SwiftTerm.TerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 400))
        view.terminalDelegate = context.coordinator
        view.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        model.output = { [weak view] data in view?.feed(byteArray: Array(data)[...]) }
        model.resize(cols: view.getTerminal().cols, rows: view.getTerminal().rows)
        return view
    }
    func updateNSView(_ nsView: SwiftTerm.TerminalView, context: Context) { }
    static func dismantleNSView(_ nsView: SwiftTerm.TerminalView, coordinator: Coordinator) {
        coordinator.model.disconnect(); coordinator.model.output = nil; nsView.terminalDelegate = nil
    }
    @MainActor final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
        let model: CustomerTerminalModel
        init(model: CustomerTerminalModel) { self.model = model }
        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) { model.resize(cols: newCols, rows: newRows) }
        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) { model.input(Data(data)) }
        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) { }
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) { }
        func scrolled(source: SwiftTerm.TerminalView, position: Double) { }
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) { }
        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {
            guard let url = URL(string: link), ["https", "http"].contains(url.scheme) else { return }
            NSWorkspace.shared.open(url)
        }
        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) { }
        func clipboardRead(source: SwiftTerm.TerminalView) -> Data? { nil }
    }
}

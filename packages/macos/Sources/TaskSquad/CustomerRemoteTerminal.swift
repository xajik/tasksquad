import AppKit
import SwiftUI
@preconcurrency import SwiftTerm
import TaskSquadCore
import TaskSquadPortal

/// Uses the same single-use tickets and binary input/resize frames as the web
/// portal. SwiftTerm supplies an AppKit renderer and VT parser, not a WebView.
struct CustomerRemoteTerminal: View {
    let api: CustomerAPI?
    let sessionID: String
    @StateObject private var model: PortalTerminalSession
    @State private var attempt = UUID()

    init(api: CustomerAPI?, sessionID: String) {
        self.api = api
        self.sessionID = sessionID
        _model = StateObject(wrappedValue: PortalTerminalSession(sessionID: sessionID, ticketProvider: { id in
            guard let api else { throw URLError(.userAuthenticationRequired) }
            let value = try await api.request(["terminal", "ticket"], method: "POST", body: .object(["session_id": .string(id)]))
            guard let ticket = value["ticket"]?.string else { throw URLError(.badServerResponse) }
            return ticket
        }, socketURLProvider: { id, ticket, replay in
            guard let api else { throw URLError(.userAuthenticationRequired) }
            var parts = URLComponents(url: try api.url(["terminal", id], query: ["ticket": ticket, "replay": replay ? "1" : "0"]), resolvingAgainstBaseURL: false)!
            parts.scheme = parts.scheme == "https" ? "wss" : "ws"
            guard let url = parts.url else { throw URLError(.badURL) }
            return url
        }))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Circle().fill(model.connected ? Color.green : Color.orange).frame(width: 6, height: 6)
                Text(model.status).font(.caption)
                Spacer(); Button("Reconnect") { model.disconnect(); attempt = UUID() }
            }.padding(8)
            CustomerTerminalView(model: model)
        }
        .task(id: attempt) { await model.connect() }
        .onDisappear { model.disconnect() }
    }
}

private struct CustomerTerminalView: NSViewRepresentable {
    let model: PortalTerminalSession
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeNSView(context: Context) -> SwiftTerm.TerminalView {
        let view = SwiftTerm.TerminalView(frame: NSRect(x: 0, y: 0, width: 800, height: 400))
        view.terminalDelegate = context.coordinator
        view.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        model.onOutput = { [weak view] data in view?.feed(byteArray: Array(data)[...]) }
        model.resize(cols: view.getTerminal().cols, rows: view.getTerminal().rows)
        return view
    }
    func updateNSView(_ nsView: SwiftTerm.TerminalView, context: Context) { }
    static func dismantleNSView(_ nsView: SwiftTerm.TerminalView, coordinator: Coordinator) {
        coordinator.model.disconnect(); coordinator.model.onOutput = nil; nsView.terminalDelegate = nil
    }
    @MainActor final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
        let model: PortalTerminalSession
        init(model: PortalTerminalSession) { self.model = model }
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

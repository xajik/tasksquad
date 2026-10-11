import SwiftUI
import TaskSquadPortal
import UIKit
import SwiftTerm

struct PortalTerminalScreen: View {
    let portal: PortalRow
    let api: PortalAPI?
    let demo: Bool
    let close: () -> Void
    @StateObject private var terminal: PortalTerminalSession
    @State private var reconnectID = UUID()
    @State private var confirmClose = false

    init(portal: PortalRow, api: PortalAPI?, demo: Bool, close: @escaping () -> Void) {
        self.portal = portal
        self.api = api
        self.demo = demo
        self.close = close
        if let api, !demo, !portal.sessionID.isEmpty {
            _terminal = StateObject(wrappedValue: api.terminalSession(sessionID: portal.sessionID))
        } else {
            _terminal = StateObject(wrappedValue: PortalTerminalSession(sessionID: portal.sessionID,
                ticketProvider: { _ in throw URLError(.userAuthenticationRequired) },
                socketURLProvider: { _, _, _ in throw URLError(.userAuthenticationRequired) }))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Circle().fill(demo || terminal.connected ? .green : .orange).frame(width: 7, height: 7)
                Text(demo ? "Connected · Demo" : terminal.status).font(.caption)
                Spacer()
                Button("Reconnect", systemImage: "arrow.clockwise") { terminal.disconnect(); reconnectID = UUID() }
                    .labelStyle(.iconOnly).accessibilityLabel("Reconnect terminal")
            }.padding(.horizontal).padding(.vertical, 10)
            if !demo {
                IOSNativeTerminalView(model: terminal)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("$ tsq portal attach \(portal.id)").foregroundStyle(.green)
                    Text("Connected to Demo Agent").foregroundStyle(.white)
                    Text("Portal terminal is ready.").foregroundStyle(.white)
                    Spacer()
                }.font(.system(.callout, design: .monospaced)).padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading).background(Color.black).accessibilityIdentifier("demo-terminal")
            }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle(portal.agent).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Close", role: .destructive) { confirmClose = true }.accessibilityIdentifier("close-portal") } }
        .confirmationDialog("Close this Portal?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Close Portal", role: .destructive, action: close)
            Button("Cancel", role: .cancel) { }
        } message: { Text("The remote terminal session will be closed.") }
        .task(id: reconnectID) { if !demo { await terminal.connect() } }
        .onDisappear { terminal.disconnect() }
    }
}

private struct IOSNativeTerminalView: UIViewRepresentable {
    let model: PortalTerminalSession
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        let view = SwiftTerm.TerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        view.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        model.onOutput = { [weak view] data in view?.feed(byteArray: Array(data)[...]) }
        model.resize(cols: view.getTerminal().cols, rows: view.getTerminal().rows)
        view.backgroundColor = .black
        return view
    }
    func updateUIView(_ uiView: SwiftTerm.TerminalView, context: Context) { }
    static func dismantleUIView(_ uiView: SwiftTerm.TerminalView, coordinator: Coordinator) {
        coordinator.model.onOutput = nil
        coordinator.model.disconnect()
        uiView.terminalDelegate = nil
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
        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) { }
        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) { UIPasteboard.general.string = String(data: content, encoding: .utf8) }
        func clipboardRead(source: SwiftTerm.TerminalView) -> Data? { UIPasteboard.general.string.map { Data($0.utf8) } }
    }
}

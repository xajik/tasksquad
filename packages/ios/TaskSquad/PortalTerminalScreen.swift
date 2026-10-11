import SwiftUI
import TaskSquadPortal
import UIKit
import SwiftTerm

struct PortalTerminalScreen: View {
    let sessionID: String
    let api: PortalAPI
    @StateObject private var terminal: PortalTerminalSession
    @State private var reconnectID = UUID()
    @State private var showKeyboard = false
    @Environment(\.scenePhase) private var phase
    init(sessionID: String, api: PortalAPI) {
        self.sessionID = sessionID; self.api = api
        _terminal = StateObject(wrappedValue: api.terminalSession(sessionID: sessionID))
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Circle().fill(terminal.connected ? .green : .orange).frame(width: 7, height: 7)
                Text(terminal.status).font(.caption).accessibilityIdentifier("terminal-status")
                Spacer()
                Button("Reconnect", systemImage: "arrow.clockwise") { reconnectID = UUID() }.labelStyle(.iconOnly).accessibilityLabel("Reconnect terminal")
            }.padding(12)
            IOSNativeTerminalView(model: terminal).accessibilityIdentifier("live-terminal")
            HStack {
                ForEach([("Esc", "\u{1b}"), ("Tab", "\t"), ("Ctrl-C", "\u{03}"), ("↑", "\u{1b}[A"), ("↓", "\u{1b}[B")], id: \.0) { key in
                    Button(key.0) { terminal.input(Data(key.1.utf8)) }.buttonStyle(.bordered).disabled(!terminal.connected)
                }
            }.font(.caption).padding(8)
        }
        .task(id: "\(reconnectID):\(phase)") {
            guard phase == .active else { terminal.disconnect(); return }
            await terminal.connect()
        }
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
        view.accessibilityLabel = "Remote terminal"
        model.onOutput = { [weak view] data in
            view?.feed(byteArray: Array(data)[...])
            view?.accessibilityValue = String(decoding: data, as: UTF8.self)
        }
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

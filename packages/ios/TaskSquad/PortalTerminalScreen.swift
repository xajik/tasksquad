import SwiftUI
import TaskSquadPortal
import UIKit
import SwiftTerm

struct PortalTerminalScreen: View {
    let sessionID: String
    let api: CustomerAPI
    @StateObject private var terminal: PortalTerminalSession
    @State private var reconnectID = UUID()
    @State private var showKeyboard = false
    @State private var input = ""
    @FocusState private var inputFocused: Bool
    @Environment(\.scenePhase) private var phase
    init(sessionID: String, api: CustomerAPI) {
        self.sessionID = sessionID; self.api = api
        _terminal = StateObject(wrappedValue: api.terminalSession(sessionID: sessionID))
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Circle().fill(terminal.connected ? MobileTheme.live : MobileTheme.warning).frame(width: 7, height: 7)
                Text(terminal.status).font(.caption).accessibilityIdentifier("terminal-status")
                Spacer()
                Button(showKeyboard || inputFocused ? "Hide keyboard" : "Show keyboard", systemImage: "keyboard") {
                    if showKeyboard || inputFocused { showKeyboard = false; inputFocused = false; UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                    else { showKeyboard = true }
                }.labelStyle(.iconOnly)
                Button { reconnectID = UUID() } label: { MobileIcon(name: "refresh-cw") }.accessibilityLabel("Reconnect terminal")
            }.padding(12)
            IOSNativeTerminalView(model: terminal, keyboardRequested: showKeyboard).accessibilityIdentifier("live-terminal")
            HStack {
                TextField("Terminal input", text: $input).focused($inputFocused).textInputAutocapitalization(.never).autocorrectionDisabled().textFieldStyle(.roundedBorder).accessibilityIdentifier("terminal-input").onSubmit { sendLine() }
                Button("Send") { sendLine() }.disabled(!terminal.connected || input.isEmpty).accessibilityIdentifier("send-terminal-input")
            }.padding(.horizontal, 12).padding(.top, 8)
            ScrollView(.horizontal, showsIndicators: false) { HStack {
                ForEach([("Esc", "\u{1b}"), ("Tab", "\t"), ("Ctrl-C", "\u{03}"), ("↑", "\u{1b}[A"), ("↓", "\u{1b}[B")], id: \.0) { key in
                    Button(key.0) { terminal.input(Data(key.1.utf8)) }.buttonStyle(.bordered).disabled(!terminal.connected)
                }
            }.font(.caption).padding(8) }
        }
        .task(id: "\(reconnectID):\(phase)") {
            guard phase == .active else { terminal.disconnect(); return }
            await terminal.connect()
        }
        .onDisappear { terminal.disconnect() }
    }
    private func sendLine() {
        guard terminal.connected, !input.isEmpty else { return }
        terminal.input(Data((input + "\r").utf8)); input = ""
    }
}

private struct IOSNativeTerminalView: UIViewRepresentable {
    let model: PortalTerminalSession
    let keyboardRequested: Bool
    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        let view = SwiftTerm.TerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        view.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        view.accessibilityIdentifier = "live-terminal"
        view.accessibilityLabel = "Remote terminal"
        model.onOutput = { [weak view] data in
            view?.feed(byteArray: Array(data)[...])
            view?.accessibilityValue = String(decoding: data.suffix(65536), as: UTF8.self).replacingOccurrences(of: "\u{1b}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
        }
        model.resize(cols: view.getTerminal().cols, rows: view.getTerminal().rows)
        view.backgroundColor = UIColor(MobileTheme.ink)
        return view
    }
    func updateUIView(_ uiView: SwiftTerm.TerminalView, context: Context) {
        if context.coordinator.keyboardRequested != keyboardRequested {
            context.coordinator.keyboardRequested = keyboardRequested
            if keyboardRequested { uiView.becomeFirstResponder() } else { uiView.resignFirstResponder() }
        }
    }
    static func dismantleUIView(_ uiView: SwiftTerm.TerminalView, coordinator: Coordinator) {
        coordinator.model.onOutput = nil
        coordinator.model.disconnect()
        uiView.terminalDelegate = nil
    }
    @MainActor final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
        let model: PortalTerminalSession
        var keyboardRequested = false
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

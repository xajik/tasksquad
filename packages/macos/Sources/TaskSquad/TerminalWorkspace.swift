import AppKit
import SwiftUI
import TaskSquadCore

@MainActor final class TerminalWorkspaceModel: ObservableObject {
    @Published var panes: [TmuxPane] = []
    @Published var selectedID: String?
    @Published var screen: TerminalScreen?
    @Published var error: String?
    @Published var attached = false
    @Published var fitWindow = false
    @Published var history = false
    @Published var query = ""
    @Published var socketPath = ""
    var managedClient: ManagedTerminalClient?
    var managedSessions: [String: ManagedTerminalTarget] = [:]
    private var managedSelection: ManagedTerminalTarget?
    private var client: TmuxControlClient?
    private var refreshTask: Task<Void, Never>?
    private var inputTask: Task<Void, Never>?
    private var pendingInput = Data()
    private var pendingSubmissions: [Int] = []
    private var lastSize: (Int, Int)?
    private var resizeTask: Task<Void, Never>?
    private var generation = UUID()
    var connection: TmuxConnection { .init(socketPath: socketPath.isEmpty ? nil : socketPath) }
    var selected: TmuxPane? { panes.first { $0.id == selectedID } }
    var filtered: [TmuxPane] { panes.filter { query.isEmpty || [$0.sessionName, $0.command, $0.directory, $0.title].contains(where: { $0.localizedCaseInsensitiveContains(query) }) } }

    func refresh() async {
        let current = connection
        do {
            let next = try await current.panes()
            guard current.socketPath == connection.socketPath else { return }
            if panes != next { panes = next }
        } catch { self.error = error.localizedDescription }
    }
    func attach(_ pane: TmuxPane) {
        detach(); selectedID = pane.id; screen = nil; history = false; error = nil
        managedSelection = connection.socketPath == nil ? managedSessions[pane.sessionName] : nil
        do {
            let control = try TmuxControlClient(connection: connection, sessionID: pane.sessionID)
            client = control; attached = true
            let current = generation
            refreshTask = Task {
                do {
                    while !Task.isCancelled {
                        let value = try await TmuxTerminal.screen(client: control, paneID: pane.paneID, history: history ? 2000 : 0)
                        guard !Task.isCancelled, generation == current else { return }
                        if screen != value { screen = value }
                        try await Task.sleep(for: .milliseconds(history ? 250 : 60))
                    }
                } catch is CancellationError { }
                catch {
                    guard generation == current else { return }
                    self.error = error.localizedDescription; detach(); await refresh()
                }
            }
            if fitWindow, let size = lastSize { lastSize = nil; resize(columns: size.0, rows: size.1) }
        } catch { self.error = error.localizedDescription }
    }
    func detach() {
        generation = UUID(); refreshTask?.cancel(); refreshTask = nil
        resizeTask?.cancel(); resizeTask = nil; inputTask?.cancel(); inputTask = nil
        pendingInput.removeAll(); pendingSubmissions.removeAll(); client?.disconnect(); client = nil; attached = false
    }
    func send(_ data: Data) {
        guard attached, !history, let control = client, let pane = selected else { return }
        guard pendingInput.count + data.count <= 1024 * 1024 else { error = "Paste is too large. Send less than 1 MiB at a time."; return }
        // A Return key submits; newlines inside a pasted block do not.
        if data == Data([13]) || data == Data([10]) { pendingSubmissions.append(pendingInput.count) }
        pendingInput.append(data)
        guard inputTask == nil else { return }
        let current = generation
        let target = managedSelection
        let managed = managedClient
        let needsOwner = requiresOwner(pane)
        inputTask = Task {
            defer { if generation == current { inputTask = nil } }
            do {
                while !pendingInput.isEmpty && !Task.isCancelled {
                    let chunk = Data(pendingInput.prefix(4096)); pendingInput.removeFirst(chunk.count)
                    let submit = pendingSubmissions.contains { $0 < chunk.count }
                    pendingSubmissions = pendingSubmissions.filter { $0 >= chunk.count }.map { $0 - chunk.count }
                    if let target, let managed { try await managed.send(chunk, submit: submit, pane: pane.paneID, target: target) }
                    else if needsOwner { throw ManagedTerminalError.ownerUnavailable }
                    else { try await TmuxTerminal.send(chunk, client: control, paneID: pane.paneID) }
                }
            } catch { if generation == current { self.error = error.localizedDescription; pendingInput.removeAll(); pendingSubmissions.removeAll() } }
        }
    }
    func resize(columns: Int, rows: Int) {
        guard lastSize?.0 != columns || lastSize?.1 != rows else { return }
        lastSize = (columns, rows)
        resizeTask?.cancel()
        guard let client, fitWindow else { return }
        resizeTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(150))
                _ = try await client.command("refresh-client -f '!ignore-size'")
                _ = try await client.command("refresh-client -C \(max(20, min(500, columns))),\(max(5, min(200, rows)))")
            } catch is CancellationError { } catch { self.error = error.localizedDescription }
        }
    }
    func fittingChanged() {
        resizeTask?.cancel(); resizeTask = nil
        if fitWindow, let size = lastSize { lastSize = nil; resize(columns: size.0, rows: size.1) }
        else if let client { Task { _ = try? await client.command("refresh-client -f ignore-size") } }
    }
    func closeSelected() async {
        guard let pane = selected else { return }
        let currentConnection = connection
        do {
            if let target = managedSelection, let managedClient {
                try await managedClient.close(target)
                var remains = true
                for _ in 0..<50 {
                    remains = try await currentConnection.panes().contains { $0.sessionID == pane.sessionID }
                    if !remains { break }
                    try await Task.sleep(for: .milliseconds(100))
                }
                if remains { throw ManagedTerminalError.closePending }
            } else if requiresOwner(pane) { throw ManagedTerminalError.ownerUnavailable }
            else { try await currentConnection.closeSession(pane.sessionID) }
            guard selectedID == pane.id, connection.socketPath == currentConnection.socketPath else { await refresh(); return }
            detach(); selectedID = nil; screen = nil; error = nil
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    private func requiresOwner(_ pane: TmuxPane) -> Bool {
        guard connection.socketPath == nil else { return false }
        return pane.sessionName.range(of: "^tsq-[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression) != nil
    }
    var closesManagedTask: Bool { managedSelection != nil }
}

struct TerminalWorkspace: View {
    @ObservedObject var model: TerminalWorkspaceModel
    @State private var closing = false
    @State private var socketEditor = false
    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                HStack { Image(systemName: "magnifyingglass").foregroundStyle(.secondary); TextField("Find a session", text: $model.query).textFieldStyle(.plain) }.padding(14)
                Divider()
                List(selection: $model.selectedID) {
                    ForEach(model.filtered) { pane in
                        HStack(alignment: .top, spacing: 10) {
                            RoundedRectangle(cornerRadius: 7).fill(pane.isAgent ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.12))
                                .frame(width: 32, height: 32).overlay(Image(systemName: pane.isAgent ? "person.crop.square" : "terminal").foregroundStyle(pane.isAgent ? Color.accentColor : Color.secondary))
                            VStack(alignment: .leading, spacing: 5) {
                                Text(pane.sessionName).fontWeight(.medium).lineLimit(1)
                                HStack(spacing: 5) { Circle().fill(pane.dead ? .gray : .green).frame(width: 6, height: 6); Text(pane.command); Text(pane.paneID).foregroundStyle(.tertiary) }.font(.caption).foregroundStyle(.secondary)
                                Text(pane.directory).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                            }
                        }.padding(.vertical, 5).tag(pane.id)
                    }
                }.listStyle(.sidebar)
                Divider()
                HStack { Text("\(model.panes.count) panes").font(.caption).foregroundStyle(.secondary); Spacer(); Button { socketEditor.toggle() } label: { Image(systemName: "network") }.help("Choose tmux socket") }.padding(12)
            }.frame(minWidth: 210, idealWidth: 260, maxWidth: 330)
            VStack(spacing: 0) {
                if let pane = model.selected {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(pane.sessionName).font(.headline)
                            Text("\(pane.command) · \(pane.paneID)" + (model.screen.map { " · \($0.columns) × \($0.rows)" } ?? "")).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if model.attached {
                            Toggle("History", isOn: $model.history).toggleStyle(.button).help("Read the last 2,000 lines; input is paused while viewing history")
                            Toggle("Fit", isOn: $model.fitWindow).toggleStyle(.button).help("Let this window influence tmux's terminal size")
                            Button("Detach") { model.detach() }
                        } else { Button("Attach") { model.attach(pane) } }
                        Button(role: .destructive) { closing = true } label: { Image(systemName: "xmark.circle") }.help("Close this session and its processes")
                    }.padding(16)
                    Divider()
                    if let screen = model.screen {
                        if model.history { SourceTextView(text: TerminalANSI.plain(screen.text)) }
                        else { NativeTerminal(screen: screen, enabled: model.attached, input: model.send, resize: model.resize) }
                    } else { ProgressView("Attaching…").frame(maxWidth: .infinity, maxHeight: .infinity) }
                    HStack(spacing: 7) {
                        Circle().fill(model.attached ? Color.green : Color.gray).frame(width: 6, height: 6)
                        Text(model.history ? "History · input paused" : model.attached ? "Live · click the terminal to type" : "Detached · session keeps running")
                        Spacer(); Text("⌘C Copy · ⌘V Paste · Shift-drag to select")
                    }.font(.caption).foregroundStyle(.secondary).padding(10)
                } else {
                    VStack(spacing: 14) {
                        Image(systemName: "terminal").font(.system(size: 40)).foregroundStyle(.tint)
                        Text(model.panes.isEmpty ? "No tmux sessions" : "Open an agent session").font(.title2.weight(.semibold))
                        Text("Select a session to see its live terminal and work with the agent here.")
                            .foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 360)
                        Text("Sessions started by either daemon appear automatically.").font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if let error = model.error {
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary)
                }
            }.frame(minWidth: 420)
        }
        .onChange(of: model.selectedID) { id in
            if let pane = model.panes.first(where: { $0.id == id }) { model.attach(pane) }
        }
        .onChange(of: model.fitWindow) { _ in model.fittingChanged() }
        .task {
            while !Task.isCancelled { await model.refresh(); do { try await Task.sleep(for: .seconds(2)) } catch { return } }
        }
        .onDisappear { model.detach() }
        .confirmationDialog("Close \(model.selected?.sessionName ?? "session")?", isPresented: $closing, titleVisibility: .visible) {
            Button("Close Session", role: .destructive) { Task { await model.closeSelected() } }
            Button("Cancel", role: .cancel) { }
        } message: { Text(model.closesManagedTask ? "This marks the task complete and ends its session through the daemon. Use Detach to leave the agent running." : "This ends every pane and running process in this session. Use Detach to leave the agent running.") }
        .popover(isPresented: $socketEditor) {
            VStack(alignment: .leading, spacing: 12) {
                Text("tmux socket").font(.headline)
                Text("Leave empty for the default server, or enter an absolute socket path.").font(.caption).foregroundStyle(.secondary)
                TextField("Default socket", text: $model.socketPath).textFieldStyle(.roundedBorder)
                Button("Connect") { model.detach(); model.selectedID = nil; model.panes = []; model.error = nil; socketEditor = false; Task { await model.refresh() } }
            }.padding(20).frame(width: 360)
        }
    }
}

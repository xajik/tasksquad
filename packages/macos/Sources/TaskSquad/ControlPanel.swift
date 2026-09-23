import AppKit
import SwiftUI
import TaskSquadCore

@MainActor final class ControlPanelModel: ObservableObject {
    @Published var configuration: DaemonConfiguration?
    @Published var error: String?
    @Published var document = ""
    @Published var savedDocument = ""
    @Published var logFiles: [URL] = []
    @Published var logText = ""
    @Published var selectedLog: URL?
    @Published var loginInProgress = false
    @Published var loginEmail: String?
    @Published var engineRunning = false
    @Published var engineBusy = false
    @Published var agentSnapshots: [AgentSnapshot] = []
    @Published var observedAgents: [ObservedAgent] = []
    @Published var selectedAgentID: String?
    @Published var observationDate: Date?
    @Published var observationError: String?
    func observeAgents() async {
        guard !engineRunning, let configuration else { observedAgents = []; return }
        do {
            let values = try await AgentObservation.read(port: configuration.ui.port)
            guard !engineRunning else { return }
            terminals.managedClient = ManagedTerminalClient(port: configuration.hooks.port)
            terminals.managedSessions = values.filter { !$0.session.isEmpty && !$0.taskID.isEmpty }.reduce(into: [:]) {
                $0[$1.session] = ManagedTerminalTarget(agentID: $1.id, taskID: $1.taskID, session: $1.session)
            }
            observedAgents = values.filter { value in configuration.agents.contains { $0.id == value.id } }
            observationDate = Date(); observationError = nil
        } catch {
            observedAgents = []; observationError = "Existing daemon is unavailable"; observationDate = nil
        }
    }
    func cancelAgent(_ id: String) async { await engine?.cancelAgent(id); agentSnapshots = await engine?.snapshots() ?? [] }

    let terminals = TerminalWorkspaceModel()
    let paths: TaskSquadPaths
    let configurationURL: URL
    private var watcher: ConfigurationWatcher?
    private var loginTask: Task<Void, Never>?
    private var engine: DaemonEngine?
    private var snapshotTask: Task<Void, Never>?
    private var authentication: Authentication?
    private var authenticationKey: (url: String, key: String)?

    /// Shared between manual sign-in and the running engine's own token
    /// refresh so both go through one actor's pending/credentialGeneration
    /// state — separate Authentication instances would each think they're the
    /// only writer of the (single, shared) Keychain entries, letting one
    /// silently revert what the other just wrote.
    private func sharedAuthentication() -> Authentication {
        let url = configuration?.server.url ?? "https://api.tasksquad.ai"
        let key = configuration?.firebase.apiKey ?? ""
        if let authentication, authenticationKey?.url == url, authenticationKey?.key == key { return authentication }
        let created = Authentication(apiURL: url, firebaseAPIKey: key)
        authentication = created; authenticationKey = (url, key)
        return created
    }

    init(paths: TaskSquadPaths = .init(), loadSavedAccount: Bool = true) {
        self.paths = paths
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--config"), args.indices.contains(index + 1), !args[index + 1].hasPrefix("-") {
            configurationURL = URL(fileURLWithPath: args[index + 1])
        } else { configurationURL = paths.config }
        // An unfamiliar executable may need Keychain authorization. Account
        // display must never block window creation or trigger that prompt.
        if loadSavedAccount {
            Task { [weak self] in
                let email = await Task.detached { try? KeychainCredentialStore().readWithoutPrompt(.email) }.value
                if self?.loginEmail == nil { self?.loginEmail = email }
            }
        }
    }

    func load() async {
        let url = configurationURL
        do {
            let (configuration, text) = try await Task.detached {
                (try DaemonConfiguration.load(from: url), try String(contentsOf: url, encoding: .utf8))
            }.value
            self.configuration = configuration
            // Only advance savedDocument when there are no unsaved local edits.
            // Otherwise an external change (another process, a text editor) would
            // silently become the new "original" and defeat save()'s conflict check.
            if document == savedDocument { document = text; savedDocument = text }
            error = nil
            if watcher == nil {
                watcher = try ConfigurationWatcher(url: url) { [weak self] result in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        switch result {
                        case .success: await self.load()
                        case .failure(let error): self.error = error.localizedDescription
                        }
                    }
                }
            }
        } catch { self.error = error.localizedDescription }
    }

    func save() async {
        let text = document, url = configurationURL, original = savedDocument
        do {
            try await Task.detached {
                _ = try DaemonConfiguration.parse(text)
                let existing = try String(contentsOf: url, encoding: .utf8)
                guard existing == original else { throw ConfigurationError("Configuration changed on disk. Reload before saving.") }
                let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                try Data(text.utf8).write(to: url, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: attributes[.posixPermissions] ?? 0o600], ofItemAtPath: url.path)
            }.value
            savedDocument = text
            await load()
        } catch { self.error = error.localizedDescription }
    }

    func revealConfiguration() { NSWorkspace.shared.activateFileViewerSelecting([configurationURL]) }
    func signIn() {
        guard !loginInProgress else { return }
        loginInProgress = true
        let dashboardURL = configuration?.dashboardURL ?? "https://tasksquad.ai"
        let auth = sharedAuthentication()
        loginTask = Task {
            defer { loginInProgress = false; loginTask = nil }
            do {
                let flow = try await LoginFlow.begin(dashboardURL: dashboardURL)
                NSWorkspace.shared.open(flow.browserURL)
                let callback = try await flow.result()
                try await auth.acceptLogin(idToken: callback.idToken, refreshToken: callback.refreshToken, email: callback.email)
                loginEmail = callback.email
                error = nil
            } catch is CancellationError { }
            catch { self.error = error.localizedDescription }
        }
    }
    func cancelLogin() { loginTask?.cancel() }
    func startEngine() async {
        guard !engineBusy, !engineRunning, let configuration else { return }
        engineBusy = true
        defer { engineBusy = false }
        let candidate = DaemonEngine(configuration: configuration, paths: paths, tokens: sharedAuthentication()) { [weak self] message in
            Task { @MainActor [weak self] in self?.error = message }
        }
        do {
            try await candidate.start()
            engine = candidate
            engineRunning = true
            error = nil
            snapshotTask = Task {
                while !Task.isCancelled {
                    agentSnapshots = await candidate.snapshots()
                    do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
                }
            }
        } catch { self.error = error.localizedDescription }
    }
    func stopEngine() async {
        guard !engineBusy else { return }
        engineBusy = true
        defer { engineBusy = false }
        await engine?.stop()
        // Await the poll loop's exit before touching agentSnapshots: cancelling it
        // only requests cancellation, it doesn't interrupt an in-flight snapshot
        // fetch, which could otherwise resolve after (and overwrite) the reset below.
        snapshotTask?.cancel()
        await snapshotTask?.value
        snapshotTask = nil
        agentSnapshots = []
        engine = nil
        engineRunning = false
    }
    func forcePoll() async { await engine?.forcePoll() }
    func shutdown() async {
        terminals.detach()
        cancelLogin()
        await loginTask?.value
        // A launch operation contains only short startup awaits, so wait for it
        // before terminating; otherwise the new engine could outlive this cleanup.
        while engineBusy { try? await Task.sleep(for: .milliseconds(20)) }
        await stopEngine()
    }
    func refreshLogs() async {
        let roots = [paths.logs, paths.tasks]
        logFiles = await Task.detached {
            let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey]
            return roots.flatMap { root -> [URL] in
                guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys,
                    options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
                return enumerator.compactMap { $0 as? URL }
            }.filter {
                ["log", "jsonl", "json", "md", "markdown"].contains($0.pathExtension.lowercased()) && (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
            }.sorted { $0.lastPathComponent > $1.lastPathComponent }
        }.value
    }
    func readLog(_ url: URL?) async {
        selectedLog = url
        guard let url else { logText = ""; return }
        do {
            let text = try await Task.detached {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                let size = try handle.seekToEnd()
                let limit: UInt64 = 512 * 1024
                try handle.seek(toOffset: size > limit ? size - limit : 0)
                let data = try handle.readToEnd() ?? Data()
                return (size > limit ? "Showing the last 512 KiB.\n\n" : "") + String(decoding: data, as: UTF8.self)
            }.value
            if selectedLog == url { logText = text }
        } catch { self.error = error.localizedDescription }
    }
}

enum PanelSection: String, CaseIterable, Identifiable {
    case agents = "Agents", supervisor = "Supervisor", sessions = "Sessions", tasks = "Tasks"
    case logs = "Daemon Logs", tools = "Tools", configuration = "Configuration"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .agents: "person.3"
        case .supervisor: "eye"
        case .sessions: "terminal"
        case .tasks: "checklist"
        case .logs: "doc.text"
        case .tools: "wrench.and.screwdriver"
        case .configuration: "gearshape"
        }
    }
}

struct ControlPanel: View {
    @ObservedObject var model: ControlPanelModel
    @State private var section: PanelSection? = .agents
    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "person.3.sequence.fill").font(.title2).foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("TaskSquad").font(.headline)
                        HStack(spacing: 5) { Circle().fill(model.engineRunning ? Color.green : Color.secondary).frame(width: 6, height: 6); Text(model.engineRunning ? "Engine online" : "Local workspace").font(.caption).foregroundStyle(.secondary) }
                    }
                }.padding(20)
                List(PanelSection.allCases, selection: $section) { item in
                    Label(item.rawValue, systemImage: item.icon).padding(.vertical, 4).tag(item)
                }.listStyle(.sidebar)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 200)
            .safeAreaInset(edge: .bottom) {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Development build", systemImage: "hammer")
                    Text("Currently supports stdout tasks. Other providers are in progress.").font(.caption).foregroundStyle(.secondary)
                }.padding()
            }
        } detail: {
            VStack(spacing: 0) {
                if let error = model.error {
                    HStack { Image(systemName: "exclamationmark.triangle"); Text(error); Spacer() }
                        .foregroundStyle(.red).padding().textSelection(.enabled)
                    Divider()
                }
                detail
            }
            .navigationTitle(section?.rawValue ?? "TaskSquad")
        }
        .task {
            while !Task.isCancelled {
                await model.observeAgents()
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
        .toolbar {
            Button { Task { await model.load() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
            if model.engineRunning {
                Button("Poll Now") { Task { await model.forcePoll() } }
                Button("Stop Engine") { Task { await model.stopEngine() } }.disabled(model.engineBusy)
            } else {
                Button("Start Engine") { Task { await model.startEngine() } }
                    .disabled(model.configuration == nil || model.engineBusy)
            }
        }
    }

    @ViewBuilder private var detail: some View {
        switch section ?? .agents {
        case .agents:
            AgentWorkspace(model: model) { pane in
                section = .sessions
                model.terminals.attach(pane)
            }
        case .supervisor:
            Form {
                LabeledContent("Supervisor", value: model.configuration?.supervisor?.command ?? "Not configured")
                LabeledContent("Dreamer", value: model.configuration?.dreamer?.command ?? "Uses supervisor command")
                LabeledContent("Dreaming window", value: "\(model.configuration?.dreamer?.windowStart.nonEmpty ?? "01:00") – \(model.configuration?.dreamer?.windowEnd.nonEmpty ?? "05:00")")
            }.formStyle(.grouped)
        case .configuration:
            VStack(alignment: .leading) {
                Text(model.configurationURL.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                TextEditor(text: $model.document).font(.system(.body, design: .monospaced))
                HStack {
                    Button("Show in Finder") { model.revealConfiguration() }
                    Spacer()
                    Button("Discard Changes") { model.document = model.savedDocument }
                    Button("Save Configuration") { Task { await model.save() } }.keyboardShortcut("s")
                        .disabled(model.document == model.savedDocument)
                }
            }.padding()
        case .tasks:
            TaskWorkspace(model: model)
        case .logs:
            HSplitView {
                List(selection: $model.selectedLog) {
                    ForEach(model.logFiles.filter { $0.pathExtension == "log" }, id: \.self) { url in
                        VStack(alignment: .leading, spacing: 4) {
                            Label(url.lastPathComponent, systemImage: url.pathExtension == "log" ? "doc.text" : "curlybraces").lineLimit(1)
                            Text(url.deletingLastPathComponent().lastPathComponent).font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 5).tag(url)
                    }
                }.frame(minWidth: 200, idealWidth: 240, maxWidth: 320)
                if let url = model.selectedLog { DocumentPreview(url: url).id(url) }
                else { empty("Read your agent's activity", "Select a log or task journal. New output appears automatically.") }
            }
            .task {
                while !Task.isCancelled { await model.refreshLogs(); do { try await Task.sleep(for: .seconds(2)) } catch { return } }
            }
        case .sessions:
            TerminalWorkspace(model: model.terminals)
        case .tools:
            Form {
                Section("Account") {
                    if let email = model.loginEmail { LabeledContent("Signed in", value: email) }
                    if model.loginInProgress {
                        HStack { ProgressView().controlSize(.small); Text("Waiting for browser sign-in"); Button("Cancel") { model.cancelLogin() } }
                    } else { Button("Sign In to TaskSquad") { model.signIn() } }
                }
                LabeledContent("Configuration", value: model.configurationURL.path)
                LabeledContent("Logs", value: model.paths.logs.path)
                if let config = model.configuration {
                    LabeledContent("API", value: config.server.url)
                    LabeledContent("Hooks port", value: String(config.hooks.port))
                    LabeledContent("Poll interval", value: "\(config.server.pollInterval) seconds")
                }
                Button("Open Logs in Finder") { NSWorkspace.shared.open(model.paths.logs) }
            }.formStyle(.grouped).textSelection(.enabled)
        }
    }
    private func empty(_ title: String, _ message: String) -> some View {
        VStack(spacing: 12) {
            Text(title).font(.title2)
            Text(message).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).padding()
    }
}

private extension String { var nonEmpty: String? { isEmpty ? nil : self } }

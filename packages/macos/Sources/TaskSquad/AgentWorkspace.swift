import AppKit
import SwiftUI
import TaskSquadCore

struct AgentWorkspace: View {
    @ObservedObject var model: ControlPanelModel
    let attach: (TmuxPane) -> Void
    @State private var selectedTab = "Activity"
    @State private var cancelling = false
    @State private var query = ""
    private var agentFolders: [(path: String, agents: [DaemonConfiguration.Agent])] {
        let groups = Dictionary(grouping: model.configuration?.agents ?? []) { agent in
            (model.paths.expandHome(agent.workDir) as NSString).standardizingPath
        }
        return groups.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }.compactMap { path in
            let agents = (groups[path] ?? []).filter {
                query.isEmpty || path.localizedCaseInsensitiveContains(query) || $0.name.localizedCaseInsensitiveContains(query)
            }
            return agents.isEmpty ? nil : (path: path, agents: agents)
        }
    }
    private var selected: DaemonConfiguration.Agent? { model.configuration?.agents.first { $0.id == model.selectedAgentID } }
    private func observed(_ id: String) -> ObservedAgent? { model.observedAgents.first { $0.id == id } }
    private func snapshot(_ id: String) -> AgentSnapshot? { model.agentSnapshots.first { $0.id == id } }
    private func mode(_ id: String) -> String { model.engineRunning ? snapshot(id)?.mode.rawValue ?? "starting" : observed(id)?.mode ?? "offline" }
    private func color(_ mode: String) -> Color {
        switch mode { case "running": Theme.live; case "waiting_input": Theme.amber; case "wrapping_up": .purple; case "idle": Theme.brand; default: Theme.mutedForeground }
    }
    private func badge(_ mode: String) -> Badge {
        switch mode {
        case "idle": Badge("Online", variant: .success)
        case "offline", "starting": Badge(mode.capitalized)
        default: Badge(status: mode)
        }
    }
    private func taskID(_ id: String) -> String { model.engineRunning ? snapshot(id)?.taskID ?? "" : observed(id)?.taskID ?? "" }
    private func logURL(_ agent: DaemonConfiguration.Agent) -> URL? {
        if let path = observed(agent.id)?.logPath, !path.isEmpty { return URL(fileURLWithPath: path) }
        let id = taskID(agent.id)
        return model.logFiles.first { $0.lastPathComponent == id + ".log" }
    }
    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                SearchField("Find an agent or folder", text: $query).padding(12)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(agentFolders, id: \.path) { folder in
                            HStack(spacing: 6) {
                                Icon(.folder, size: 12)
                                Text(folder.path.isEmpty ? "No working folder" : (folder.path as NSString).abbreviatingWithTildeInPath)
                                    .font(.system(size: 11, weight: .medium, design: .monospaced)).lineLimit(1).truncationMode(.head)
                            }
                            .foregroundStyle(Theme.mutedForeground).help(folder.path)
                            .padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 4)
                            ForEach(folder.agents) { agent in
                                Button { model.selectedAgentID = agent.id } label: {
                                    HStack(spacing: 10) {
                                        StatusDot(active: ["running", "idle"].contains(mode(agent.id)), color: color(mode(agent.id)))
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(agent.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.foreground)
                                            Text(mode(agent.id).replacingOccurrences(of: "_", with: " ")).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                                        }
                                    }.rowBackground(selected: model.selectedAgentID == agent.id)
                                }.buttonStyle(.plain)
                            }
                        }
                    }.padding(.horizontal, 8).padding(.bottom, 8)
                }
                HStack(spacing: 6) {
                    StatusDot(active: model.engineRunning || model.observationDate != nil, size: 6)
                    Text(model.engineRunning ? "Native engine · live" : model.observedAgents.isEmpty ? "Engine offline" : "Existing daemon · live")
                    Spacer()
                }.font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).padding(12).edgeBorder(.top)
            }.frame(minWidth: 220, idealWidth: 260, maxWidth: 320).edgeBorder(.trailing)
            if let agent = selected {
                VStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            Text(agent.name).font(.system(size: 20, weight: .bold)).foregroundStyle(Theme.foreground)
                            badge(mode(agent.id))
                            Spacer()
                            if model.engineRunning, snapshot(agent.id)?.mode != .idle {
                                Button("Stop Task") { cancelling = true }.buttonStyle(.tsq(.destructive, size: .default))
                            }
                            Button {
                                Task {
                                    await model.terminals.refresh()
                                    let session = model.engineRunning ? snapshot(agent.id).map { "tsq-" + $0.sessionID } : observed(agent.id)?.session
                                    if let pane = model.terminals.panes.first(where: { $0.sessionName == session }) { attach(pane) }
                                    else { model.error = "No tmux session is currently associated with \(agent.name). Open Sessions to browse all terminals." }
                                }
                            } label: { Label("Open Terminal", icon: .terminal) }
                            .buttonStyle(.tsq(.outline, size: .default))
                            .disabled((model.engineRunning ? true : observed(agent.id)?.session.isEmpty ?? true))
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            Label(agent.command, icon: .terminal).help("Launch command: \(agent.command)")
                            Label(model.paths.expandHome(agent.workDir), icon: .folder).help("Working directory: \(model.paths.expandHome(agent.workDir))")
                        }
                        .labelStyle(TSQLabelStyle(spacing: 6))
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Theme.mutedForeground)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    }.padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 12)
                    HStack {
                        Picker("Agent detail", selection: $selectedTab) { Text("Activity").tag("Activity"); Text("Log").tag("Log"); Text("Details").tag("Details") }.pickerStyle(.segmented).labelsHidden().frame(width: 260)
                        Spacer()
                        if let date = model.observationDate { Text("Updated \(date, style: .time)").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground) }
                    }.padding(.horizontal, 20).padding(.bottom, 12)
                    Rectangle().fill(Theme.border).frame(height: 1)
                    if selectedTab == "Log", let url = logURL(agent) { DocumentPreview(url: url).id(url) }
                    else if selectedTab == "Details" {
                        Form {
                            LabeledContent("Agent ID", value: agent.id)
                            LabeledContent("Provider", value: agent.provider.isEmpty ? "Automatic" : agent.provider)
                            LabeledContent("Launch command", value: agent.command)
                            LabeledContent("Working directory", value: model.paths.expandHome(agent.workDir))
                            LabeledContent("Task", value: taskID(agent.id).isEmpty ? "No active task" : taskID(agent.id))
                            if let observed = observed(agent.id) {
                                LabeledContent("Last poll", value: observed.pullAgo)
                                LabeledContent("tmux session", value: observed.session.isEmpty ? "None" : observed.session)
                            }
                            Button("Open Working Directory") { NSWorkspace.shared.open(URL(fileURLWithPath: model.paths.expandHome(agent.workDir))) }
                        }.formStyle(.grouped).scrollContentBackground(.hidden).textSelection(.enabled)
                    } else if !taskID(agent.id).isEmpty {
                        TaskActivityView(url: model.paths.tasks.appendingPathComponent(taskID(agent.id) + ".jsonl"))
                    } else {
                        EmptyState(icon: .messagesSquare, title: mode(agent.id) == "offline" ? "Agent is offline" : "Ready for the next task",
                                   message: "Task messages and lifecycle events will appear here as they arrive.")
                    }
                }.frame(minWidth: 460)
            } else {
                EmptyState(icon: .bot, title: "Choose an agent", message: "Follow activity, inspect logs, and open its terminal.")
            }
        }
        .task {
            if model.selectedAgentID == nil { model.selectedAgentID = model.configuration?.agents.first?.id }
            while !Task.isCancelled { await model.refreshLogs(); do { try await Task.sleep(for: .seconds(2)) } catch { return } }
        }
        .onChange(of: model.configuration?.agents.first?.id) { first in
            if model.selectedAgentID == nil { model.selectedAgentID = first }
        }
        .confirmationDialog("Stop this task?", isPresented: $cancelling, titleVisibility: .visible) {
            Button("Stop Task", role: .destructive) { if let agent = selected { Task { await model.cancelAgent(agent.id) } } }
        } message: { Text("The process will stop and its session will close as cancelled. The agent stays online.") }
    }
}

private struct TaskActivityView: View {
    let url: URL
    @State private var records: [JSONPreviewNode] = []
    @State private var error: String?
    @State private var follow = true
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        ForEach(records) { record in
                            let fields = record.children
                            let kind = fields.first { $0.label == "type" }?.value ?? "event"
                            let role = fields.first { $0.label == "role" }?.value ?? "TaskSquad"
                            let text = fields.first { ["body", "final_text", "subject", "summary"].contains($0.label) }?.value ?? fields.first { $0.label == "status" }?.value ?? record.raw
                            // Task journals record the person as "user"; older ones used "human".
                            let person = ["user", "human"].contains(role)
                            HStack(alignment: .top, spacing: 12) {
                                Icon(kind == "message" ? (person ? .user : .sparkles) : .zap, size: 14)
                                    .foregroundStyle(person ? Theme.primary : Theme.mutedForeground).frame(width: 30, height: 30)
                                    .background(person ? Theme.primary.opacity(0.1) : Theme.muted, in: Circle())
                                VStack(alignment: .leading, spacing: 7) {
                                    HStack { Text(kind == "message" ? role.capitalized : kind.replacingOccurrences(of: "_", with: " ").capitalized).fontWeight(.semibold); if let timestamp = fields.first(where: { ["ts", "timestamp"].contains($0.label) }) { Text(timestamp.value).font(.caption).foregroundStyle(.secondary) } }
                                    Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)).lineSpacing(5).textSelection(.enabled)
                                }
                                Spacer(minLength: 0)
                            }.id(record.id)
                        }
                        if let error { Text(error).foregroundStyle(.secondary) }
                        Color.clear.frame(height: 1).id("end")
                    }.padding(24)
                }.background(Theme.background)
                .onChange(of: records) { _ in if follow { proxy.scrollTo("end", anchor: .bottom) } }
            }
            HStack { Text("Task activity").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground); Spacer(); Toggle("Follow latest", isOn: $follow).toggleStyle(.checkbox).font(.system(size: 12)) }
                .padding(.horizontal, 16).padding(.vertical, 10).edgeBorder(.top)
        }.task(id: url) {
            records = []; error = nil
            while !Task.isCancelled {
                do {
                    let target = url
                    let next = try await Task.detached { try JSONPreviewNode.parse(PreviewDocument.load(target).text, lines: true) }.value
                    guard !Task.isCancelled else { return }
                    if records != next { records = next }; error = nil
                } catch { self.error = "Waiting for the task journal…" }
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
        }
    }
}

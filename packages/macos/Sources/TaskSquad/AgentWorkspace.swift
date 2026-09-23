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
        switch mode { case "running": .green; case "waiting_input": .orange; case "wrapping_up": .purple; case "idle": .blue; default: .secondary }
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
                HStack { Image(systemName: "magnifyingglass").foregroundStyle(.secondary); TextField("Find an agent or folder", text: $query).textFieldStyle(.plain) }.padding(14)
                Divider()
                List(selection: $model.selectedAgentID) {
                    ForEach(agentFolders, id: \.path) { folder in
                        Label(folder.path.isEmpty ? "No working folder" : folder.path, systemImage: "folder")
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(nil)
                            .fixedSize(horizontal: false, vertical: true)
                            .help(folder.path)
                            .padding(.top, 10)
                            .padding(.bottom, 4)
                        ForEach(folder.agents) { agent in
                            HStack(spacing: 10) {
                                Text(String(agent.name.prefix(2)).uppercased()).font(.system(size: 11, weight: .bold)).foregroundStyle(Color.accentColor)
                                    .frame(width: 34, height: 34).background(Color.accentColor.opacity(0.13), in: RoundedRectangle(cornerRadius: 8))
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(agent.name).fontWeight(.medium)
                                    HStack(spacing: 5) { Circle().fill(color(mode(agent.id))).frame(width: 6, height: 6); Text(mode(agent.id).replacingOccurrences(of: "_", with: " ")) }.font(.caption).foregroundStyle(.secondary)
                                }
                            }.padding(.vertical, 6).tag(agent.id)
                        }
                    }
                }.listStyle(.sidebar)
                Divider()
                HStack { Circle().fill(model.engineRunning || model.observationDate != nil ? Color.green : Color.gray).frame(width: 6, height: 6); Text(model.engineRunning ? "Native engine · live" : model.observedAgents.isEmpty ? "Engine offline" : "Existing daemon · live").font(.caption).foregroundStyle(.secondary); Spacer() }.padding(12)
            }.frame(minWidth: 200, idealWidth: 240, maxWidth: 300)
            if let agent = selected {
                VStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 14) {
                            Text(agent.name).font(.title3.weight(.semibold))
                            Label(mode(agent.id).replacingOccurrences(of: "_", with: " "), systemImage: "circle.fill").font(.caption).foregroundStyle(color(mode(agent.id)))
                            Spacer()
                            Button("Open Terminal") {
                                Task {
                                    await model.terminals.refresh()
                                    let session = model.engineRunning ? snapshot(agent.id).map { "tsq-" + $0.sessionID } : observed(agent.id)?.session
                                    if let pane = model.terminals.panes.first(where: { $0.sessionName == session }) { attach(pane) }
                                    else { model.error = "No tmux session is currently associated with \(agent.name). Open Sessions to browse all terminals." }
                                }
                            }.disabled((model.engineRunning ? true : observed(agent.id)?.session.isEmpty ?? true))
                            if model.engineRunning, snapshot(agent.id)?.mode != .idle {
                                Button("Stop Task", role: .destructive) { cancelling = true }
                            }
                        }
                        VStack(alignment: .leading, spacing: 5) {
                            Label(agent.command, systemImage: "terminal")
                                .help("Launch command: \(agent.command)")
                            Label(model.paths.expandHome(agent.workDir), systemImage: "folder")
                                .help("Working directory: \(model.paths.expandHome(agent.workDir))")
                        }
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    }.padding(18)
                    HStack {
                        Picker("Agent detail", selection: $selectedTab) { Text("Activity").tag("Activity"); Text("Log").tag("Log"); Text("Details").tag("Details") }.pickerStyle(.segmented).labelsHidden().frame(width: 260)
                        Spacer()
                        if let date = model.observationDate { Text("Updated \(date, style: .time)").font(.caption).foregroundStyle(.secondary) }
                    }.padding(.horizontal, 18).padding(.bottom, 14)
                    Divider()
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
                        }.formStyle(.grouped).textSelection(.enabled)
                    } else if !taskID(agent.id).isEmpty {
                        TaskActivityView(url: model.paths.tasks.appendingPathComponent(taskID(agent.id) + ".jsonl"))
                    } else {
                        VStack(spacing: 12) {
                            Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 34)).foregroundStyle(.tint)
                            Text(mode(agent.id) == "offline" ? "Agent is offline" : "Ready for the next task").font(.title3.weight(.medium))
                            Text("Task messages and lifecycle events will appear here as they arrive.").foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }.frame(minWidth: 460)
            } else {
                VStack(spacing: 12) { Image(systemName: "person.3").font(.largeTitle).foregroundStyle(.tint); Text("Choose an agent").font(.title2); Text("Follow activity, inspect logs, and open its terminal.").foregroundStyle(.secondary) }.frame(maxWidth: .infinity, maxHeight: .infinity)
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
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: kind == "message" ? (role == "human" ? "person.fill" : "sparkles") : "bolt.fill")
                                    .font(.system(size: 14)).foregroundStyle(.tint).frame(width: 32, height: 32).background(Color.accentColor.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
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
                }.background(Color(nsColor: .textBackgroundColor))
                .onChange(of: records) { _ in if follow { proxy.scrollTo("end", anchor: .bottom) } }
            }
            Divider()
            HStack { Text("Task activity").font(.caption).foregroundStyle(.secondary); Spacer(); Toggle("Follow latest", isOn: $follow).toggleStyle(.checkbox) }.padding(12)
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

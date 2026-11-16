import SwiftUI
import TaskSquadCore
import TaskSquadDesign
import TaskSquadPortalUI

struct TaskWorkspace: View {
    @ObservedObject var model: ControlPanelModel
    @State private var entries: [TaskHistoryEntry] = []
    @State private var selectedID: URL?
    @State private var query = ""
    @State private var kind: TaskHistoryEntry.Kind?
    @State private var index = TaskHistoryIndex()
    private var filtered: [TaskHistoryEntry] { entries.filter { (kind == nil || $0.kind == kind) && $0.matches(query) } }
    private var selected: TaskHistoryEntry? { filtered.first { $0.id == selectedID } }

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                List(selection: $selectedID) {
                    ForEach(filtered) { entry in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(entry.title).font(Theme.body.weight(.medium)).lineLimit(2)
                            Text([entry.kind.rawValue, entry.agent].filter { !$0.isEmpty }.joined(separator: " · ")).font(Theme.caption).foregroundStyle(.secondary)
                            if !entry.project.isEmpty {
                                Label(entry.project, systemImage: "folder").font(Theme.caption).foregroundStyle(.secondary)
                                    .lineLimit(1).truncationMode(.middle).help(entry.project)
                            }
                            Text(entry.modified, format: .dateTime.day().month().year()).font(Theme.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 2).tag(entry.id)
                    }
                }
                .listStyle(.inset)
                .overlay { if filtered.isEmpty, !query.isEmpty { ContentUnavailableView.search(text: query) } }
                Divider()
                Text("\(filtered.count) local runs").font(Theme.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(10)
            }.frame(minWidth: 260, idealWidth: 300, maxWidth: 380, maxHeight: .infinity)
            if let entry = selected {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(entry.title).font(Theme.title).foregroundStyle(Theme.foreground)
                        Text([entry.kind.rawValue, entry.agent, entry.taskID].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                        if !entry.project.isEmpty {
                            Label(entry.project, icon: .folder).labelStyle(TSQLabelStyle(spacing: 4)).font(Theme.caption).textSelection(.enabled)
                            if entry.projectFromConfiguration {
                                Text("Folder from current agent configuration; this older run did not record its folder.")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        } else {
                            Text("Project folder was not recorded.").font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.horizontal, 20).padding(.vertical, 16)
                    Divider()
                    DocumentPreview(url: entry.url).id(entry.url)
                }.frame(minWidth: 400, maxHeight: .infinity)
            } else {
                EmptyState(icon: .listChecks, title: filtered.isEmpty ? "No matching runs" : "Choose a task or background run",
                           message: "Search by task, agent, or project folder. Supervisor and dreamer logs appear here too.")
            }
        }
        .searchable(text: $query, placement: .toolbar, prompt: "Search task, agent or project")
        .toolbar {
            ToolbarItem {
                Picker("Run Type", selection: $kind) {
                    Text("All Runs").tag(TaskHistoryEntry.Kind?.none)
                    ForEach(TaskHistoryEntry.Kind.allCases, id: \.self) { Text($0.rawValue).tag(Optional($0)) }
                }.pickerStyle(.menu).help("Filter by run type")
            }
        }
        .task {
            while !Task.isCancelled {
                let next = await index.load(paths: model.paths, agents: model.configuration?.agents ?? [])
                guard !Task.isCancelled else { return }
                if next != entries { entries = next }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
    }
}

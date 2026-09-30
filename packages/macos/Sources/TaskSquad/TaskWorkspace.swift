import SwiftUI
import TaskSquadCore

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
                VStack(alignment: .leading, spacing: 8) {
                    SearchField("Search task, agent, or project", text: $query)
                    SelectMenu(title: "Run type", selection: $kind,
                               options: [(nil, "All runs")] + TaskHistoryEntry.Kind.allCases.map { (Optional($0), $0.rawValue) })
                }.padding(12)
                TSQList(items: filtered, selection: $selectedID) { entry in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(2)
                            Text([entry.kind.rawValue, entry.agent].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                            if !entry.project.isEmpty {
                                Label(entry.project, icon: .folder).labelStyle(TSQLabelStyle(spacing: 4)).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                                    .lineLimit(1).truncationMode(.middle).help(entry.project)
                            }
                            Text(entry.modified, style: .date).font(.system(size: 11)).foregroundStyle(Theme.mutedForeground)
                        }
                }
                Text("\(filtered.count) local runs").font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12).edgeBorder(.top)
            }.frame(minWidth: 260, idealWidth: 300, maxWidth: 380).edgeBorder(.trailing)
            if let entry = selected {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(entry.title).font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.foreground)
                        Text([entry.kind.rawValue, entry.agent, entry.taskID].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                        if !entry.project.isEmpty {
                            Label(entry.project, icon: .folder).labelStyle(TSQLabelStyle(spacing: 4)).font(.system(size: 12)).textSelection(.enabled)
                            if entry.projectFromConfiguration {
                                Text("Folder from current agent configuration; this older run did not record its folder.")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        } else {
                            Text("Project folder was not recorded.").font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.horizontal, 20).padding(.vertical, 16)
                    Rectangle().fill(Theme.border).frame(height: 1)
                    DocumentPreview(url: entry.url).id(entry.url)
                }.frame(minWidth: 400)
            } else {
                EmptyState(icon: .listChecks, title: filtered.isEmpty ? "No matching runs" : "Choose a task or background run",
                           message: "Search by task, agent, or project folder. Supervisor and dreamer logs appear here too.")
            }
        }.task {
            while !Task.isCancelled {
                let next = await index.load(paths: model.paths, agents: model.configuration?.agents ?? [])
                guard !Task.isCancelled else { return }
                if next != entries { entries = next }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
    }
}

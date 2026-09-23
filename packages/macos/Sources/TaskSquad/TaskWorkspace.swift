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
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search task, agent, or project", text: $query).textFieldStyle(.plain)
                }.padding(14)
                Picker("Run type", selection: $kind) {
                    Text("All runs").tag(nil as TaskHistoryEntry.Kind?)
                    ForEach(TaskHistoryEntry.Kind.allCases, id: \.self) { Text($0.rawValue).tag(Optional($0)) }
                }.padding(.horizontal, 12).padding(.bottom, 10)
                Divider()
                List(selection: $selectedID) {
                    ForEach(filtered) { entry in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(entry.title).fontWeight(.medium).lineLimit(2)
                            Text([entry.kind.rawValue, entry.agent].filter { !$0.isEmpty }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                            if !entry.project.isEmpty {
                                Label(entry.project, systemImage: "folder").font(.caption).foregroundStyle(.secondary)
                                    .lineLimit(1).truncationMode(.middle).help(entry.project)
                            }
                            Text(entry.modified, style: .date).font(.caption2).foregroundStyle(.secondary)
                        }.padding(.vertical, 6).tag(entry.id)
                    }
                }.listStyle(.sidebar)
                Divider()
                Text("\(filtered.count) local runs").font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            }.frame(minWidth: 260, idealWidth: 300, maxWidth: 380)
            if let entry = selected {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(entry.title).font(.title3.weight(.semibold))
                        Text([entry.kind.rawValue, entry.agent, entry.taskID].filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                        if !entry.project.isEmpty {
                            Label(entry.project, systemImage: "folder").font(.caption).textSelection(.enabled)
                            if entry.projectFromConfiguration {
                                Text("Folder from current agent configuration; this older run did not record its folder.")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        } else {
                            Text("Project folder was not recorded.").font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(16)
                    Divider()
                    DocumentPreview(url: entry.url).id(entry.url)
                }.frame(minWidth: 400)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "checklist").font(.largeTitle).foregroundStyle(.tint)
                    Text(filtered.isEmpty ? "No matching runs" : "Choose a task or background run").font(.title3)
                    Text("Search by task, agent, or project folder. Supervisor and dreamer logs appear here too.")
                        .foregroundStyle(.secondary).multilineTextAlignment(.center)
                }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
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

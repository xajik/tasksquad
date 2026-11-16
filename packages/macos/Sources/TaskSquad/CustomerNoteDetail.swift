import SwiftUI
import TaskSquadCore
import TaskSquadPortal

struct CustomerNoteDetail: View {
    @ObservedObject var model: CustomerWorkspaceModel
    @ObservedObject var ui: WorkspaceUI
    let record: CustomerRecord
    @State private var comment = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(record.title).font(Theme.title).textSelection(.enabled)
                if !record.strings("tags").isEmpty {
                    HStack(spacing: 6) { ForEach(record.strings("tags"), id: \.self) { Badge("#" + $0) } }
                }
                CustomerMarkdown(text: record.text("content"))
                Divider()
                if !model.related.isEmpty {
                    Text("Linked tasks").font(Theme.headline)
                    ForEach(model.related) { task in
                        HStack { Button(task.title) { model.openTask(task.id) }.buttonStyle(.link); CustomerStatus(status: task.status) }
                    }
                    Divider()
                }
                Text("Comments").font(Theme.headline)
                ForEach(model.comments) { entry in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(entry.text("agent_name", fallback: entry.text("author_id") == model.profile?.id ? "You" : "Team member")).font(Theme.body.weight(.semibold))
                            Spacer(); Text(entry.date.formatted(date: .abbreviated, time: .shortened)).font(Theme.caption).foregroundStyle(.secondary)
                            if entry.text("author_id") == model.profile?.id || model.isMaintainer {
                                Button {
                                    let operation = WorkspaceOperation.deleteComment(project: model.teamID, note: record.id, comment: entry.id)
                                    ui.confirmation = CustomerConfirmation(title: "Delete comment?", message: "This cannot be undone.", action: "Delete") { await model.run(operation) }
                                } label: { Image(systemName: "trash") }.buttonStyle(.borderless).help("Delete comment").accessibilityLabel("Delete comment")
                            }
                        }
                        CustomerMarkdown(text: entry.text("content"))
                    }.padding(12).background(Theme.muted, in: RoundedRectangle(cornerRadius: Theme.radius))
                }
                TextField("Add a comment…", text: $comment, axis: .vertical).lineLimit(3...10).textFieldStyle(.roundedBorder)
                Button("Add Comment") {
                    let operation = WorkspaceOperation.comment(project: model.teamID, note: record.id, content: comment)
                    Task { if await model.perform(operation) != nil { comment = ""; await model.refresh() } }
                }.buttonStyle(.borderedProminent).disabled(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
            }.padding(24).frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

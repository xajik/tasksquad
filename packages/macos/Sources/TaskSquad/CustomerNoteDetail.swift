import SwiftUI
import TaskSquadCore

struct CustomerNoteDetail: View {
    @ObservedObject var model: CustomerWorkspaceModel
    let record: CustomerRecord
    let edit: () -> Void
    @Binding var editor: CustomerEditorRequest?
    @Binding var confirmation: CustomerConfirmation?
    @State private var comment = ""
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(record.title).font(.system(size: 24, weight: .bold)).foregroundStyle(Theme.foreground).textSelection(.enabled)
                HStack(spacing: 8) {
                    Button(action: edit) { Label("Edit", icon: .pencil) }.buttonStyle(.tsqOutline)
                    Button(record.number("archived_at") > 0 ? "Unarchive" : "Archive") {
                        let path = model.teamPath("notes", id: record.id) + ["archive"]
                        Task { await model.perform(path, method: record.number("archived_at") > 0 ? "DELETE" : "POST") }
                    }.buttonStyle(.tsqOutline)
                    Menu {
                        Button("Convert to Task…") { sendToAgent(critique: false) }
                        Button("Request Critique…") { sendToAgent(critique: true) }
                    } label: { Text("Send to Agent") }.menuStyle(.button).controlSize(.small).fixedSize()
                    Spacer()
                    Button {
                        let path = model.teamPath("notes", id: record.id)
                        confirmation = CustomerConfirmation(title: "Delete \(record.title)?", message: "This note and its comments will be permanently removed.", action: "Delete") {
                            if await model.mutate(path, method: "DELETE") != nil { model.selectedID = nil; await model.refresh() }
                        }
                    } label: { Icon(.trash, size: 14) }.buttonStyle(.tsqIcon).foregroundStyle(Theme.destructive).help("Delete note")
                }.disabled(model.busy)
                if !record.strings("tags").isEmpty {
                    HStack(spacing: 6) { ForEach(record.strings("tags"), id: \.self) { Badge("#" + $0) } }
                }
                CustomerMarkdown(text: record.text("content"))
                Rectangle().fill(Theme.border).frame(height: 1)
                if !model.related.isEmpty {
                    Text("Linked tasks").font(.system(size: 15, weight: .semibold))
                    ForEach(model.related) { task in
                        HStack { Button(task.title) { model.openTask(task.id) }.buttonStyle(.link); CustomerStatus(status: task.status) }
                    }
                    Rectangle().fill(Theme.border).frame(height: 1)
                }
                Text("Comments").font(.system(size: 15, weight: .semibold))
                ForEach(model.comments) { entry in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(entry.text("agent_name", fallback: entry.text("author_id") == model.profile?.id ? "You" : "Team member")).font(.system(size: 13, weight: .semibold))
                            Spacer(); Text(entry.date.formatted()).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                            if entry.text("author_id") == model.profile?.id || model.isMaintainer {
                                Button {
                                    let path = model.teamPath("notes", id: record.id) + ["comments", entry.id]
                                    confirmation = CustomerConfirmation(title: "Delete comment?", message: "This cannot be undone.", action: "Delete") { await model.perform(path, method: "DELETE") }
                                } label: { Icon(.trash, size: 13) }.buttonStyle(.plain).foregroundStyle(Theme.mutedForeground).help("Delete comment")
                            }
                        }
                        CustomerMarkdown(text: entry.text("content"))
                    }.padding(14).background(Theme.muted.opacity(0.4), in: RoundedRectangle(cornerRadius: Theme.radius))
                }
                TextEditor(text: $comment).font(.system(size: 13)).scrollContentBackground(.hidden).frame(minHeight: 90).padding(8)
                    .overlay(alignment: .topLeading) {
                        if comment.isEmpty { Text("Add a comment…").font(.system(size: 13)).foregroundStyle(Theme.mutedForeground).padding(13).allowsHitTesting(false) }
                    }
                    .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.border))
                Button("Add Comment") {
                    let path = model.teamPath("notes", id: record.id), text = comment
                    Task { if await model.mutate(path + ["comments"], body: ["content": .string(text)]) != nil { comment = ""; await model.refresh() } }
                }.buttonStyle(.tsqPrimary).disabled(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy)
            }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func sendToAgent(critique: Bool) {
        let path = model.teamPath("notes", id: record.id) + [critique ? "critique" : "convert"]
        var fields: [CustomerField] = [.init("agent_id", "Agent", .agent, required: true), .init(critique ? "context" : "instructions", critique ? "Context" : "Instructions", .multiline), .init("include_comments", "Include comments", .bool, initial: .bool(true))]
        if !critique { fields.append(.init("auto_close", "Auto-close task", .bool, initial: .bool(false))) }
        editor = CustomerEditorRequest(title: critique ? "Request Critique" : "Convert Note to Task", fields: fields, submitLabel: "Send") { body, _ in
            guard let result = await model.mutate(path, body: body) else { return false }
            if let id = result["task_id"]?.string { model.openTask(id) }; return true
        }
    }
}

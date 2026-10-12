import AppKit
import SwiftUI
import TaskSquadCore
import TaskSquadPortal
import UniformTypeIdentifiers

typealias CustomerField = WorkspaceField

struct CustomerEditorRequest: Identifiable {
    let id = UUID()
    let title: String
    let fields: [CustomerField]
    var attachments = false
    var phases = false
    var submitLabel = "Save"
    /// `WorkspaceDraftScope.key`; values persist until a successful submit.
    var draftKey: String? = nil
    let submit: @MainActor ([String: JSONValue], [CustomerUpload]) async -> Bool
}

struct CustomerEditor: View {
    @ObservedObject var model: CustomerWorkspaceModel
    let request: CustomerEditorRequest
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: JSONValue]
    @State private var files: [CustomerUpload] = []
    @State private var validation: String?
    @State private var submitting = false
    @State private var phaseRows: [PhaseDraft] = [.init()]
    @State private var subAgents: [CustomerRecord] = []

    init(model: CustomerWorkspaceModel, request: CustomerEditorRequest) {
        self.model = model; self.request = request
        _values = State(initialValue: request.draftKey.flatMap { model.drafts.load($0) } ?? Dictionary(uniqueKeysWithValues: request.fields.map { ($0.id, $0.initial) }))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(request.title).font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.foreground)
                .padding(.horizontal, 24).padding(.top, 22).padding(.bottom, 6)
            Form {
                ForEach(request.fields) { field in fieldView(field) }
                if request.phases { phaseEditor }
                if request.attachments {
                    Section("Images") {
                        ForEach(files) { file in
                            HStack { Text(file.name); Spacer(); Button("Remove") { files.removeAll { $0.id == file.id } } }
                        }
                        Button("Attach Images…") {
                            do { files += try CustomerFiles.chooseImages() } catch { validation = error.localizedDescription }
                        }
                    }
                }
            }.formStyle(.grouped).scrollContentBackground(.hidden)
            if let message = validation ?? model.error {
                Text(message).font(.system(size: 13)).foregroundStyle(Theme.destructive).textSelection(.enabled).padding(.horizontal, 24).padding(.bottom, 12)
            }
            HStack(spacing: 8) {
                Spacer()
                if submitting { ProgressView().controlSize(.small) }
                Button("Cancel") { dismiss() }.buttonStyle(.tsq(.outline, size: .default)).keyboardShortcut(.cancelAction).disabled(submitting)
                Button(request.submitLabel) { Task { await submit() } }.buttonStyle(.tsqPrimary)
                    .keyboardShortcut(.defaultAction).disabled(submitting || model.busy)
            }.padding(20).edgeBorder(.top)
        }.frame(width: 620, height: request.phases ? 750 : 630).background(Theme.background)
        .interactiveDismissDisabled(submitting)
        .onChange(of: values) { _, value in if let key = request.draftKey { model.drafts.save(value, key: key) } }
        .task {
            guard request.phases else { return }
            do { subAgents = CustomerRecord(try await model.api().request(WorkspacePolicy.path(.subAgents, project: model.teamID))).records("sub_agents") }
            catch { validation = error.localizedDescription }
        }
    }
    @ViewBuilder private func fieldView(_ field: CustomerField) -> some View {
        switch field.kind {
        case .text: TextField(field.label, text: string(field.id))
        case .multiline:
            VStack(alignment: .leading) {
                Text(field.label).font(.system(size: 13, weight: .medium))
                TextEditor(text: string(field.id)).font(.system(size: 13)).scrollContentBackground(.hidden).frame(minHeight: 120).padding(6)
                    .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius).strokeBorder(Theme.input))
            }
        case .bool: Toggle(field.label, isOn: boolean(field.id))
        case .integer, .optionalInteger: TextField(field.label, text: numeric(field.id))
        case .tags:
            TextField(field.label + " (comma separated)", text: Binding(get: {
                (values[field.id]?.array ?? []).compactMap(\.string).joined(separator: ", ")
            }, set: { values[field.id] = .array($0.components(separatedBy: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) }.filter { $0.string != "" }) }))
        case .choice(let choices):
            Picker(field.label, selection: string(field.id)) { ForEach(choices, id: \.self) { Text($0.capitalized).tag($0) } }
        case .agent:
            Picker(field.label, selection: string(field.id)) {
                Text(field.required ? "Select an agent" : "None").tag("")
                ForEach(model.agents) { Text($0.title).tag($0.id) }
            }
        case .subAgent:
            Picker(field.label, selection: string(field.id)) {
                Text("None").tag(""); ForEach(subAgents) { Text($0.title).tag($0.id) }
            }
        case .date:
            Toggle(field.label, isOn: Binding(get: { values[field.id]?.number != nil }, set: {
                values[field.id] = $0 ? .number(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000) : .null
            }))
            if values[field.id]?.number != nil {
                DatePicker(field.label, selection: Binding(get: {
                    Date(timeIntervalSince1970: (values[field.id]?.number ?? 0) / 1000)
                }, set: { values[field.id] = .number($0.timeIntervalSince1970 * 1000) }))
            }
        }
    }
    private var phaseEditor: some View {
        Section("Phases · executed in order") {
            ForEach($phaseRows) { $phase in
                VStack(alignment: .leading) {
                    HStack {
                        TextField("Phase name", text: $phase.name)
                        Button("Remove") { phaseRows.removeAll { $0.id == phase.id } }.disabled(phaseRows.count == 1)
                    }
                    Picker("Sub-agent", selection: $phase.subAgent) {
                        Text("Use default").tag(""); ForEach(subAgents) { Text($0.title).tag($0.id) }
                    }
                    Picker("Harness agent", selection: $phase.agent) {
                        Text("Use default").tag(""); ForEach(model.agents) { Text($0.title).tag($0.id) }
                    }
                    Stepper("Retries: \(phase.retries)", value: $phase.retries, in: 0...10)
                    Toggle("Auto-close", isOn: $phase.autoClose)
                }.padding(.vertical, 6)
            }
            Button("Add Phase") { phaseRows.append(.init()) }
        }
    }
    private func string(_ key: String) -> Binding<String> { Binding(get: { values[key]?.string ?? "" }, set: { values[key] = .string($0) }) }
    private func numeric(_ key: String) -> Binding<String> {
        Binding(get: { values[key]?.string ?? values[key]?.number.map { String(Int($0)) } ?? "" }, set: { values[key] = .string($0) })
    }
    private func boolean(_ key: String) -> Binding<Bool> {
        Binding(get: { values[key] == .bool(true) || values[key]?.number == 1 }, set: { values[key] = .bool($0) })
    }
    private func submit() async {
        guard !submitting else { return }
        validation = nil
        let body: [String: JSONValue]
        do { body = try WorkspaceEditor.payload(fields: request.fields, values: values, phases: request.phases ? phaseRows : nil, files: files) }
        catch { validation = error.localizedDescription; return }
        submitting = true; defer { submitting = false }
        if await request.submit(body, files) { if let key = request.draftKey { model.drafts.remove(key) }; dismiss() }
    }
}



@MainActor enum CustomerFiles {
    static func chooseImages() throws -> [CustomerUpload] {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.png, .jpeg, .gif, .webP]
        panel.allowsMultipleSelection = true; panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return [] }
        return try panel.urls.map { url in
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 10 * 1024 * 1024 else { throw ConfigurationError("\(url.lastPathComponent) exceeds 10 MiB.") }
            return try CustomerUpload(name: url.lastPathComponent, mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream", data: Data(contentsOf: url))
        }
    }
    static func save(_ data: Data, name: String) throws {
        let panel = NSSavePanel(); panel.nameFieldStringValue = URL(fileURLWithPath: name).lastPathComponent
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try data.write(to: url, options: .atomic)
    }
}


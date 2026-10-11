import SwiftUI
import PhotosUI
import TaskSquadPortal
import UniformTypeIdentifiers

struct MobileEditorRequest: Identifiable {
    let id = UUID()
    let title: String
    let fields: [WorkspaceField]
    var draftKey: String? = nil
    var attachments = false
    var phases = false
    var submitLabel = "Save"
    let submit: @MainActor ([String: JSONValue], [CustomerUpload]) async -> Bool
}

struct MobileEditor: View {
    @ObservedObject var model: WorkspaceStore
    let request: MobileEditorRequest
    @Environment(\.dismiss) private var dismiss
    @State private var values: [String: JSONValue]
    @State private var files: [CustomerUpload] = []
    @State private var photos: [PhotosPickerItem] = []
    @State private var chooseFiles = false
    @State private var submitting = false
    @State private var validation: String?
    @State private var phases: [String] = [""]
    @State private var subAgents: [CustomerRecord] = []
    init(model: WorkspaceStore, request: MobileEditorRequest) {
        self.model = model; self.request = request
        _values = State(initialValue: request.draftKey.flatMap { MobileDraftStore.load($0) } ?? Dictionary(uniqueKeysWithValues: request.fields.map { ($0.id, $0.initial) }))
    }
    var body: some View {
        NavigationStack {
            Form {
                ForEach(request.fields) { field in fieldView(field) }
                if request.phases {
                    Section("Phases in execution order") {
                        ForEach(phases.indices, id: \.self) { index in TextField("Phase name", text: $phases[index]) }
                        Button("Add phase") { phases.append("") }
                        if phases.count > 1 { Button("Remove last phase") { phases.removeLast() } }
                    }
                }
                if request.attachments {
                    Section("Images") {
                        ForEach(files) { file in HStack { Text(file.name); Spacer(); Button("Remove") { files.removeAll { $0.id == file.id } } } }
                        PhotosPicker("Attach photos", selection: $photos, maxSelectionCount: 5, matching: .images)
                        Button("Choose image files") { chooseFiles = true }
                        #if DEBUG
                        if ProcessInfo.processInfo.arguments.contains("--ui-test-api") {
                            Button("Attach test image") { if let data = UIImage(systemName: "star.fill")?.pngData() { addImage(data, name: "test.png", mime: "image/png") } }
                        }
                        #endif
                    }
                }
                if let message = validation ?? model.error { Text(message).foregroundStyle(.red).accessibilityIdentifier("editor-error") }
            }
            .navigationTitle(request.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(submitting) }
                ToolbarItem(placement: .confirmationAction) { Button(request.submitLabel) { Task { await submit() } }.disabled(submitting || model.busy).accessibilityIdentifier("editor-submit") }
            }
            .interactiveDismissDisabled(submitting)
            .onChange(of: values) { _, value in if let key = request.draftKey { MobileDraftStore.save(value, key: key) } }
            .onChange(of: photos) { _, items in Task {
                do { for item in items {
                    if let data = try await item.loadTransferable(type: Data.self), let png = UIImage(data: data)?.pngData() { addImage(png, name: "photo.png", mime: "image/png") }
                }; photos = [] } catch { validation = error.localizedDescription }
            } }
            .fileImporter(isPresented: $chooseFiles, allowedContentTypes: [.png, .jpeg, .gif, .webP], allowsMultipleSelection: true) { result in
                do { for url in try result.get() {
                    let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                    addImage(try Data(contentsOf: url), name: url.lastPathComponent, mime: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "image/png")
                } } catch { validation = error.localizedDescription }
            }
            .task { if request.phases { do { subAgents = CustomerRecord(try await model.api.request(["teams", model.projectID, "sub-agents"])).records("sub_agents") } catch { validation = error.localizedDescription } } }
        }
    }
    @ViewBuilder private func fieldView(_ field: WorkspaceField) -> some View {
        switch field.kind {
        case .text: TextField(field.label, text: string(field.id)).accessibilityIdentifier("field-" + field.id)
        case .multiline: Section(field.label) { TextEditor(text: string(field.id)).frame(minHeight: 120).accessibilityIdentifier("field-" + field.id) }
        case .bool: Toggle(field.label, isOn: Binding(get: { values[field.id] == .bool(true) || values[field.id]?.number == 1 }, set: { values[field.id] = .bool($0) }))
        case .integer, .optionalInteger: TextField(field.label, text: numeric(field.id)).keyboardType(.numbersAndPunctuation)
        case .tags: TextField(field.label + " (comma separated)", text: Binding(get: { (values[field.id]?.array ?? []).compactMap(\.string).joined(separator: ", ") }, set: { values[field.id] = .array($0.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) }) }))
        case .choice(let choices): Picker(field.label, selection: string(field.id)) { ForEach(choices, id: \.self) { Text($0.capitalized).tag($0) } }
        case .agent, .subAgent: Picker(field.label, selection: string(field.id)) {
            Text("Select an agent").tag("")
            ForEach(isSubAgent(field) ? subAgents : model.agents) { Text($0.title).tag($0.id) }
        }.accessibilityIdentifier("field-" + field.id)
        case .date:
            Toggle(field.label, isOn: Binding(get: { values[field.id]?.number != nil }, set: { values[field.id] = $0 ? .number(Date().addingTimeInterval(3600).timeIntervalSince1970*1000) : .null }))
            if values[field.id]?.number != nil { DatePicker(field.label, selection: Binding(get: { Date(timeIntervalSince1970: (values[field.id]?.number ?? 0)/1000) }, set: { values[field.id] = .number($0.timeIntervalSince1970*1000) })) }
        }
    }
    private func isSubAgent(_ field: WorkspaceField) -> Bool { if case .subAgent = field.kind { return true }; return false }
    private func string(_ key: String) -> Binding<String> { Binding(get: { values[key]?.string ?? "" }, set: { values[key] = .string($0) }) }
    private func numeric(_ key: String) -> Binding<String> { Binding(get: { values[key]?.string ?? values[key]?.number.map { String(Int($0)) } ?? "" }, set: { values[key] = .string($0) }) }
    private func addImage(_ data: Data, name: String, mime: String) {
        guard files.count < 5, data.count <= 10*1024*1024 else { validation = "Attach up to five images, each no larger than 10 MiB."; return }
        files.append(CustomerUpload(name: name, mimeType: mime, data: data))
    }
    private func submit() async {
        var body = values; validation = nil
        for field in request.fields {
            if field.required, (body[field.id]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, body[field.id]?.number == nil { validation = "\(field.label) is required."; return }
            switch field.kind {
            case .integer, .optionalInteger:
                let text = body[field.id]?.string ?? body[field.id]?.number.map { String(Int($0)) } ?? ""
                if text.isEmpty, case .optionalInteger = field.kind { body[field.id] = .null; continue }
                guard let number = Int(text) else { validation = "\(field.label) must be a whole number."; return }
                body[field.id] = .number(Double(number))
            case .date: if let date = body[field.id]?.number, date <= Date().timeIntervalSince1970*1000 { validation = "\(field.label) must be in the future."; return }
            default: break
            }
        }
        if request.phases {
            guard phases.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { validation = "Give every phase a name."; return }
            body["phases"] = .array(phases.map { .object(["name": .string($0)]) })
            for key in ["default_sub_agent_id", "default_harness_agent_id"] where body[key] == .string("") { body.removeValue(forKey: key) }
        }
        submitting = true; defer { submitting = false }
        if await request.submit(body, files) { if let key = request.draftKey { MobileDraftStore.remove(key) }; dismiss() }
    }
}

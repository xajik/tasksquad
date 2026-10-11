import SwiftUI
import PhotosUI
import TaskSquadPortal
import UniformTypeIdentifiers

struct MobileEditorRequest: Identifiable {
    let id = UUID()
    let title: String
    let fields: [WorkspaceField]
    var draftKey: String? = nil
    var eligibleAgentsOnly = false
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
    @FocusState private var focusedField: String?
    @State private var validation: String?
    @State private var phases: [MobilePhaseDraft] = [.init()]
    @State private var subAgents: [CustomerRecord] = []
    init(model: WorkspaceStore, request: MobileEditorRequest) {
        self.model = model; self.request = request
        _values = State(initialValue: request.draftKey.flatMap { MobileDraftStore.load($0) } ?? Dictionary(uniqueKeysWithValues: request.fields.map { ($0.id, $0.initial) }))
    }
    var body: some View {
        NavigationStack {
            Form {
                ForEach(request.attachments ? request.fields.filter { ["subject", "agent_id", "body"].contains($0.id) } : request.fields) { field in fieldView(field) }
                if request.phases {
                    Section("Phases in execution order") {
                        ForEach($phases) { $phase in
                            VStack(alignment: .leading) {
                                TextField("Phase name", text: $phase.name)
                                Picker("Harness agent", selection: $phase.agent) { Text("Use default").tag(""); ForEach(model.agents) { Text($0.title).tag($0.id) } }
                                Picker("Sub-agent", selection: $phase.subAgent) { Text("Use default").tag(""); ForEach(subAgents) { Text($0.title).tag($0.id) } }
                                Stepper("Retries: \(phase.retries)", value: $phase.retries, in: 0...10)
                                Toggle("Auto-close", isOn: $phase.autoClose)
                            }
                        }
                        Button("Add phase") { phases.append(.init()) }
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
                if request.attachments { ForEach(request.fields.filter { !["subject", "agent_id", "body"].contains($0.id) }) { field in fieldView(field) } }
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) {
                if let message = validation ?? model.error { Text(message).font(.footnote).foregroundStyle(.red).padding().frame(maxWidth: .infinity).background(.regularMaterial).accessibilityIdentifier("editor-error") }
            }
            .navigationTitle(request.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done editing") { focusedField = nil } }
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
        case .text: TextField(field.label, text: string(field.id)).focused($focusedField, equals: field.id).accessibilityIdentifier("field-" + field.id)
        case .multiline: Section(field.label) { TextEditor(text: string(field.id)).focused($focusedField, equals: field.id).frame(minHeight: 120).accessibilityIdentifier("field-" + field.id) }
        case .bool: Toggle(field.label, isOn: Binding(get: { values[field.id] == .bool(true) || values[field.id]?.number == 1 }, set: { values[field.id] = .bool($0) }))
        case .integer, .optionalInteger: TextField(field.label, text: numeric(field.id)).keyboardType(.numbersAndPunctuation)
        case .tags: TextField(field.label + " (comma separated)", text: Binding(get: { (values[field.id]?.array ?? []).compactMap(\.string).joined(separator: ", ") }, set: { values[field.id] = .array($0.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) }) }))
        case .choice(let choices): Picker(field.label, selection: string(field.id)) { ForEach(choices, id: \.self) { Text($0.capitalized).tag($0) } }
        case .agent, .subAgent: Picker(field.label, selection: string(field.id)) {
            Text("Select an agent").tag("")
            ForEach(isSubAgent(field) ? subAgents : request.eligibleAgentsOnly ? model.eligibleAgents : model.agents) { Text($0.title).tag($0.id) }
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
            guard phases.allSatisfy({ !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { validation = "Give every phase a name."; return }
            body["phases"] = .array(phases.map { phase in
                var fields: [String: JSONValue] = ["name": .string(phase.name), "max_retries": .number(Double(phase.retries)), "auto_close": .bool(phase.autoClose)]
                if !phase.agent.isEmpty { fields["harness_agent_id"] = .string(phase.agent) }
                if !phase.subAgent.isEmpty { fields["sub_agent_id"] = .string(phase.subAgent) }
                return .object(fields)
            })
            for key in ["default_sub_agent_id", "default_harness_agent_id"] where body[key] == .string("") { body.removeValue(forKey: key) }
        }
        for (key, range) in [("hour", 0...23), ("minute", 0...59), ("day_of_week", 0...6), ("day_of_month", 1...31)] {
            if let value = body[key]?.number, !range.contains(Int(value)) { validation = "\(key.replacingOccurrences(of: "_", with: " ")) must be between \(range.lowerBound) and \(range.upperBound)."; return }
        }
        if let zone = body["timezone"]?.string, TimeZone(identifier: zone) == nil { validation = "Choose a valid time zone."; return }
        submitting = true; defer { submitting = false }
        if await request.submit(body, files) { if let key = request.draftKey { MobileDraftStore.remove(key) }; dismiss() }
        else { validation = model.error ?? "The request did not complete. Your draft is retained." }
    }
}

private struct MobilePhaseDraft: Identifiable {
    let id = UUID()
    var name = "", agent = "", subAgent = ""
    var retries = 3
    var autoClose = true
}

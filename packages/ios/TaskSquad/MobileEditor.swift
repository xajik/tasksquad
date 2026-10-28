import SwiftUI
import TaskSquadPortal

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
    @State private var advancedExpanded = false
    @State private var scheduleExpanded = false
    @State private var loadingImages = false
    @State private var submitting = false
    @ScaledMetric(relativeTo: .body) private var writingHeight: CGFloat = 120
    @FocusState private var focusedField: String?
    @State private var validation: String?
    @State private var invalidField: String?
    @State private var unavailableDraftImages = false
    @State private var phases: [PhaseDraft] = [.init()]
    @State private var subAgents: [CustomerRecord] = []
    init(model: WorkspaceStore, request: MobileEditorRequest) {
        self.model = model; self.request = request
        _values = State(initialValue: request.draftKey.flatMap { MobileDraftStore.load($0) } ?? Dictionary(uniqueKeysWithValues: request.fields.map { ($0.id, $0.initial) }))
        if let key = request.draftKey {
            do { _files = State(initialValue: try MobileDraftStore.loadFiles(key)) }
            catch {
                _unavailableDraftImages = State(initialValue: true)
                _validation = State(initialValue: "Draft images could not be restored. Reopen to retry, or discard unavailable images before sending.")
            }
        }
    }
    var body: some View {
        NavigationStack {
            editorForm
            .disabled(submitting)
            .navigationTitle(request.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done editing") { focusedField = nil } }
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(submitting || loadingImages) }
                ToolbarItem(placement: .confirmationAction) {
                    submitButton
                }
            }
            .interactiveDismissDisabled(submitting || loadingImages)
            .onChange(of: values) { old, value in
                if let key = request.draftKey { MobileDraftStore.save(value, key: key) }
                if let field = invalidField, old[field] != value[field],
                   !(value[field]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || value[field]?.number != nil {
                    validation = nil; invalidField = nil
                }
            }
            .task { if request.phases { do { subAgents = CustomerRecord(try await model.api.request(["teams", model.projectID, "sub-agents"])).records("sub_agents") } catch { validation = error.localizedDescription } } }
        }
    }
    private var submitButton: some View {
        Button(submitting ? "Sending…" : request.submitLabel) { Task { await submit() } }
            .disabled(submitting || model.busy || unavailableDraftImages || loadingImages)
            .accessibilityIdentifier("editor-submit")
    }
    private var editorForm: some View {
            ScrollViewReader { scroll in
            Form {
                if let validation, invalidField == nil {
                    Section {
                        errorText(validation)
                        if unavailableDraftImages {
                            Button("Discard unavailable draft images", role: .destructive) {
                                if setFiles([]) { unavailableDraftImages = false; self.validation = nil }
                            }
                        }
                    }
                }
                ForEach(primaryFields) { field in fieldView(field) }
                if request.phases { phaseSection }
                if request.attachments { imageSection }
                if scheduledForm { MobileScheduleFields(values: $values) }
                if request.attachments, let schedule = request.fields.first(where: { $0.id == "scheduled_at" }) {
                    Section { DisclosureGroup("Send later", isExpanded: $scheduleExpanded) { fieldView(schedule) } }
                }
                if !advancedFields.isEmpty {
                    Section {
                        Button { advancedExpanded.toggle() } label: {
                            HStack { Text("Advanced"); Spacer(); MobileIcon(name: advancedExpanded ? "chevron-up" : "chevron-down", size: 16) }.frame(minHeight: 44)
                        }.accessibilityIdentifier("editor-advanced").accessibilityValue(advancedExpanded ? "Expanded" : "Collapsed")
                        if advancedExpanded {
                            ForEach(advancedFields.filter { $0.id != "save_tokens_level" || values["save_tokens_enabled"] == .bool(true) }) { field in fieldView(field) }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden).background(MobileTheme.background)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: invalidField) { _, field in
                if let field { withAnimation { scroll.scrollTo(field, anchor: .center) } }
            }
            }
    }
    private var phaseSection: some View {

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
    private var scheduledForm: Bool { request.fields.contains { $0.id == "frequency" } }
    private var primaryFields: [WorkspaceField] {
        if request.attachments { return request.fields.filter { ["subject", "agent_id", "body"].contains($0.id) } }
        if scheduledForm { return request.fields.filter { ["subject", "agent_id", "body", "frequency"].contains($0.id) } }
        return request.fields
    }
    private var advancedFields: [WorkspaceField] {
        if request.attachments { return request.fields.filter { !["subject", "agent_id", "body", "scheduled_at"].contains($0.id) } }
        if scheduledForm { return request.fields.filter { ["repeat_count", "end_date", "auto_close"].contains($0.id) } }
        return []
    }
    private var imageSection: some View {
        Section {
            MobileImageAttachments(files: Binding(get: { files }, set: { _ = setFiles($0) }), loading: $loadingImages) { message in
                invalidField = nil; validation = message
            }.disabled(unavailableDraftImages || submitting || loadingImages)
        }
    }
    private func fieldView(_ field: WorkspaceField) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            fieldControl(field)
            if case .agent = field.kind, model.agents.isEmpty {
                Text("No agents in this project. Add an agent from Agents before sending work.").font(.footnote).foregroundStyle(MobileTheme.mutedForeground)
            }
            if invalidField == field.id, let validation { errorText(validation) }
        }.id(field.id)
    }
    private func fieldLabel(_ field: WorkspaceField) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(field.label).fixedSize(horizontal: false, vertical: true)
            Text(field.required ? "Required" : "Optional").font(.caption).foregroundStyle(MobileTheme.mutedForeground)
        }
    }
    private func errorText(_ message: String) -> some View {
        Text(message).font(.footnote).foregroundStyle(MobileTheme.destructive)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("editor-error")
    }
    @ViewBuilder private func fieldControl(_ field: WorkspaceField) -> some View {
        switch field.kind {
        case .text:
            VStack(alignment: .leading, spacing: 8) {
                fieldLabel(field).font(.subheadline.weight(.medium))
                TextField(field.label, text: string(field.id)).frame(minHeight: 44).focused($focusedField, equals: field.id).accessibilityIdentifier("field-" + field.id)
            }
        case .multiline:
            VStack(alignment: .leading, spacing: 8) {
                fieldLabel(field).font(.subheadline.weight(.medium))
                TextEditor(text: string(field.id)).focused($focusedField, equals: field.id).frame(height: writingHeight).accessibilityLabel(field.label).accessibilityIdentifier("field-" + field.id)
            }
        case .bool: Toggle(field.label, isOn: Binding(get: { values[field.id] == .bool(true) || values[field.id]?.number == 1 }, set: { values[field.id] = .bool($0) }))
        case .integer, .optionalInteger:
            VStack(alignment: .leading, spacing: 8) {
                fieldLabel(field).font(.subheadline.weight(.medium))
                TextField(field.label, text: numeric(field.id)).keyboardType(.numbersAndPunctuation).focused($focusedField, equals: field.id).accessibilityIdentifier("field-" + field.id)
            }
        case .tags:
            VStack(alignment: .leading, spacing: 8) {
                fieldLabel(field).font(.subheadline.weight(.medium))
                TextField("Comma separated", text: Binding(get: { (values[field.id]?.array ?? []).compactMap(\.string).joined(separator: ", ") }, set: { values[field.id] = .array($0.split(separator: ",").map { .string($0.trimmingCharacters(in: .whitespaces)) }) })).focused($focusedField, equals: field.id).accessibilityIdentifier("field-" + field.id)
            }
        case .choice(let choices): Picker(field.label, selection: string(field.id)) { ForEach(choices, id: \.self) { Text($0.capitalized).tag($0) } }.accessibilityIdentifier("field-" + field.id)
        case .agent, .subAgent: Picker(selection: string(field.id)) {
            Text("Select an agent").tag("")
            ForEach(isSubAgent(field) ? subAgents : request.eligibleAgentsOnly ? model.eligibleAgents : model.agents) { Text($0.title).tag($0.id) }
        } label: { fieldLabel(field) }.accessibilityIdentifier("field-" + field.id)
        case .date:
            Toggle(field.label, isOn: Binding(get: { values[field.id]?.number != nil }, set: { values[field.id] = $0 ? .number(Date().addingTimeInterval(3600).timeIntervalSince1970*1000) : .null }))
            if values[field.id]?.number != nil { DatePicker(field.label, selection: Binding(get: { Date(timeIntervalSince1970: (values[field.id]?.number ?? 0)/1000) }, set: { values[field.id] = .number($0.timeIntervalSince1970*1000) })) }
        }
    }
    private func isSubAgent(_ field: WorkspaceField) -> Bool { if case .subAgent = field.kind { return true }; return false }
    private func string(_ key: String) -> Binding<String> { Binding(get: { values[key]?.string ?? "" }, set: { values[key] = .string($0) }) }
    private func numeric(_ key: String) -> Binding<String> { Binding(get: { values[key]?.string ?? values[key]?.number.map { String(Int($0)) } ?? "" }, set: { values[key] = .string($0) }) }
    private func setFiles(_ value: [CustomerUpload]) -> Bool {
        do {
            if let key = request.draftKey { try MobileDraftStore.saveFiles(value, key: key) }
            files = value
            return true
        } catch {
            invalidField = nil
            validation = "Images could not be saved to your draft. Please try again."
            return false
        }
    }
    private func submit() async {
        guard !submitting else { return }
        validation = nil
        invalidField = nil
        if let field = request.fields.first(where: { $0.required && (values[$0.id]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && values[$0.id]?.number == nil }) {
            invalidField = field.id
            validation = "\(field.label) is required."
            switch field.kind { case .text, .multiline: focusedField = field.id; default: break }
            UIAccessibility.post(notification: .announcement, argument: validation)
            return
        }
        let body: [String: JSONValue]
        do { body = try WorkspaceEditor.payload(fields: request.fields, values: values, phases: request.phases ? phases : nil, files: files) }
        catch { validation = error.localizedDescription; return }
        submitting = true; defer { submitting = false }
        if await request.submit(body, files) { if let key = request.draftKey { MobileDraftStore.remove(key) }; dismiss() }
        else { validation = model.error ?? "The request did not complete. Your draft is retained." }
    }
}



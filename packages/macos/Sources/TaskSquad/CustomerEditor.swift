import AppKit
import SwiftUI
import TaskSquadCore
import UniformTypeIdentifiers

struct CustomerField: Identifiable {
    enum Kind { case text, multiline, bool, integer, optionalInteger, date, tags, choice([String]), agent, subAgent }
    let id: String
    let label: String
    var kind: Kind = .text
    var required = false
    var initial: JSONValue = .string("")
    init(_ id: String, _ label: String, _ kind: Kind = .text, required: Bool = false, initial: JSONValue = .string("")) {
        self.id = id; self.label = label; self.kind = kind; self.required = required; self.initial = initial
    }
}

struct CustomerEditorRequest: Identifiable {
    let id = UUID()
    let title: String
    let fields: [CustomerField]
    var attachments = false
    var phases = false
    var submitLabel = "Save"
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
        _values = State(initialValue: Dictionary(uniqueKeysWithValues: request.fields.map { ($0.id, $0.initial) }))
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
        .task {
            guard request.phases else { return }
            do { subAgents = CustomerRecord(try await model.api().request(model.teamPath("sub-agents"))).records("sub_agents") }
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
        validation = nil
        var body = values
        for field in request.fields {
            if field.required, (body[field.id]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               body[field.id]?.number == nil {
                validation = "\(field.label) is required."; return
            }
            switch field.kind {
            case .integer, .optionalInteger:
                let text = body[field.id]?.string ?? body[field.id]?.number.map { String(Int($0)) } ?? ""
                if text.isEmpty, case .optionalInteger = field.kind { body[field.id] = .null; continue }
                guard let number = Int(text) else { validation = "\(field.label) must be a whole number."; return }
                body[field.id] = .number(Double(number))
            case .date:
                if let value = body[field.id]?.number, value <= Date().timeIntervalSince1970 * 1000 {
                    validation = "\(field.label) must be in the future."; return
                }
            default: break
            }
        }
        if request.phases {
            guard phaseRows.allSatisfy({ !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else {
                validation = "Give every phase a name."; return
            }
            body["phases"] = .array(phaseRows.map { phase in
                var value: [String: JSONValue] = ["name": .string(phase.name), "max_retries": .number(Double(phase.retries)), "auto_close": .bool(phase.autoClose)]
                if !phase.agent.isEmpty { value["harness_agent_id"] = .string(phase.agent) }
                if !phase.subAgent.isEmpty { value["sub_agent_id"] = .string(phase.subAgent) }
                return .object(value)
            })
            for key in ["default_sub_agent_id", "default_harness_agent_id"] where body[key] == .string("") { body.removeValue(forKey: key) }
        }
        submitting = true; defer { submitting = false }
        if await request.submit(body, files) { dismiss() }
    }
}

private struct PhaseDraft: Identifiable {
    let id = UUID()
    var name = "", agent = "", subAgent = ""
    var retries = 3
    var autoClose = true
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

extension CustomerField {
    static func fields(for section: CustomerSection, record: CustomerRecord? = nil) -> [CustomerField] {
        let fields: [CustomerField]
        switch section {
        case .inbox:
            fields = [.init("subject", "Subject", required: true), .init("agent_id", "Agent", .agent, required: true),
                .init("body", "Message", .multiline), .init("scheduled_at", "Schedule task", .date, initial: .null),
                .init("auto_close", "Auto-close after completion", .bool, initial: .bool(false)),
                .init("save_tokens_enabled", "Save tokens", .bool, initial: .bool(false)),
                .init("save_tokens_level", "Token saving level", .choice(["lite", "full", "ultra"]), initial: .string("full")),
                .init("close_steps", "Close steps (blank uses defaults)", .tags, initial: .array([]))]
        case .notes:
            fields = [.init("title", "Title", required: true), .init("content", "Content", .multiline), .init("tags", "Tags", .tags, initial: .array([]))]
        case .skills, .subAgents, .commands:
            fields = [.init("name", "Name", required: true), .init("description", "Description"), .init("content", "Content", .multiline, required: true), .init("auto_install", "Install automatically", .bool, initial: .bool(false))]
        case .agents:
            fields = [.init("name", "Name", required: true), .init("role", "Role and instructions", .multiline)]
        case .members: fields = [.init("email", "Email", required: true)]
        case .portals: fields = [.init("agent_id", "Agent", .agent, required: true)]
        case .conveyors:
            fields = [.init("subject", "Subject", required: true), .init("agent_id", "Agent", .agent, required: true), .init("body", "Message", .multiline, required: true),
                .init("frequency", "Repeat", .choice(["hourly", "daily", "weekly", "monthly"]), initial: .string("daily")),
                .init("hour", "Hour (0–23)", .integer, initial: .number(9)), .init("minute", "Minute (0–59)", .integer, initial: .number(0)),
                .init("day_of_week", "Weekday (0 = Sunday, 6 = Saturday)", .optionalInteger, initial: .number(1)),
                .init("day_of_month", "Day of month (1–31)", .optionalInteger, initial: .number(1)),
                .init("timezone", "Time zone", required: true, initial: .string(TimeZone.current.identifier)),
                .init("repeat_count", "Maximum runs (blank = unlimited)", .optionalInteger, initial: .null),
                .init("end_date", "End date", .date, initial: .null), .init("auto_close", "Auto-close tasks", .bool, initial: .bool(false))]
        case .planners:
            fields = [.init("name", "Name", required: true), .init("description", "Description", .multiline),
                .init("max_retries", "Default retries", .integer, initial: .number(3)), .init("auto_close", "Auto-close tasks", .bool, initial: .bool(true)),
                .init("default_sub_agent_id", "Default sub-agent", .subAgent), .init("default_harness_agent_id", "Default harness agent", .agent)]
        default: fields = []
        }
        guard let record else { return fields }
        return fields.map { field in
            var field = field
            if let value = record.value[field.id] { field.initial = value }
            return field
        }
    }
}

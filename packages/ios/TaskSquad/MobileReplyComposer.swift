import SwiftUI
import TaskSquadPortal

/// A reply stays beside the conversation. Secondary scheduling remains optional.
struct MobileReplyComposer: View {
    @ObservedObject var model: WorkspaceStore
    let send: @MainActor ([String: JSONValue], [CustomerUpload]) async -> String?
    private let draftKey: String
    @State private var expanded = false
    @State private var values: [String: JSONValue]
    @State private var files: [CustomerUpload] = []
    @State private var error: String?
    @State private var unavailableImages = false
    @State private var submitting = false
    @State private var loadingImages = false
    @State private var schedulePresented = false
    @FocusState private var focused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    private static let fields: [WorkspaceField] = [
        .init("body", "Message", .multiline, required: true),
        .init("scheduled_at", "Schedule reply", .date, initial: .null)
    ]

    init(model: WorkspaceStore, taskID: String, send: @escaping @MainActor ([String: JSONValue], [CustomerUpload]) async -> String?) {
        self.model = model; self.send = send
        let key = model.draftScope("reply." + taskID).key
        draftKey = key
        _values = State(initialValue: MobileDraftStore.load(key) ?? ["body": .string(""), "scheduled_at": .null])
        do { _files = State(initialValue: try MobileDraftStore.loadFiles(key)) }
        catch {
            _unavailableImages = State(initialValue: true)
            _error = State(initialValue: "Draft images could not be restored. Reopen to retry or discard unavailable images.")
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if expanded { editor }
            else {
                HStack {
                    Button { expanded = true; focused = true } label: {
                        Label("Reply…", systemImage: "arrowshape.turn.up.left").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }.accessibilityIdentifier("reply-task")
                    if !(values["body"]?.string ?? "").isEmpty || !files.isEmpty {
                        Text("Draft saved").font(.caption).foregroundStyle(MobileTheme.mutedForeground)
                    }
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .frame(maxWidth: 680).frame(maxWidth: .infinity)
        .fixedSize(horizontal: false, vertical: true)
        .background(MobileTheme.background)
        .overlay(alignment: .top) { Divider() }
        .onChange(of: values) { old, value in
            MobileDraftStore.save(value, key: draftKey)
            if old["body"] != value["body"], !unavailableImages { error = nil }
        }
        .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done editing") { focused = false } } }
    }
    private var editor: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Message").font(.subheadline.weight(.medium))
                Text("Required").font(.caption).foregroundStyle(MobileTheme.mutedForeground)
            }
            TextEditor(text: Binding(get: { values["body"]?.string ?? "" }, set: { values["body"] = .string($0) }))
                .font(.body).focused($focused).frame(height: typeSize.isAccessibilitySize ? 120 : 80)
                .accessibilityLabel("Message").accessibilityIdentifier("field-body")
            if let error {
                Text(error).font(.footnote).foregroundStyle(MobileTheme.destructive).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("editor-error")
                if unavailableImages {
                    Button("Discard unavailable draft images", role: .destructive) {
                        if saveFiles([]) { unavailableImages = false; self.error = nil }
                    }
                }
            }
            MobileImageAttachments(files: Binding(get: { files }, set: { _ = saveFiles($0) }), compact: true, loading: $loadingImages) { error = $0 }
                .disabled(unavailableImages || submitting)
            HStack(spacing: 12) {
                Button("Cancel") { focused = false; expanded = false }.frame(minHeight: 44).disabled(submitting || loadingImages)
                Button(values["scheduled_at"]?.number == nil ? "Send later" : "Scheduled") { focused = false; schedulePresented = true }
                    .frame(minHeight: 44)
                    .popover(isPresented: $schedulePresented) { scheduleOptions.padding().presentationCompactAdaptation(.popover) }
                Spacer(minLength: 0)
                Button(submitting ? "Sending…" : "Send") { Task { await submit() } }
                    .buttonStyle(.borderedProminent).foregroundStyle(MobileTheme.primaryForeground).frame(minHeight: 44)
                    .disabled(submitting || model.busy || unavailableImages || loadingImages).accessibilityIdentifier("editor-submit")
            }.font(.subheadline)
        }.disabled(submitting)
    }
    private var scheduleOptions: some View {
        VStack(alignment: .leading, spacing: 16) {
            Toggle("Schedule reply", isOn: Binding(get: { values["scheduled_at"]?.number != nil }, set: {
                values["scheduled_at"] = $0 ? .number(Date().addingTimeInterval(3600).timeIntervalSince1970 * 1000) : .null
            }))
            if values["scheduled_at"]?.number != nil {
                DatePicker("Send at", selection: Binding(get: { Date(timeIntervalSince1970: (values["scheduled_at"]?.number ?? 0)/1000) }, set: { values["scheduled_at"] = .number($0.timeIntervalSince1970 * 1000) }))
            }
            Button("Done") { schedulePresented = false }.frame(minHeight: 44)
        }.frame(minWidth: 240)
    }
    private func saveFiles(_ updated: [CustomerUpload]) -> Bool {
        do { try MobileDraftStore.saveFiles(updated, key: draftKey); files = updated; return true }
        catch { self.error = "Images could not be saved to your draft. Please try again."; return false }
    }
    private func submit() async {
        guard !submitting, !loadingImages, !unavailableImages else { return }
        let payload: [String: JSONValue]
        do { payload = try WorkspaceEditor.payload(fields: Self.fields, values: values, files: files) }
        catch {
            self.error = error.localizedDescription; focused = true
            UIAccessibility.post(notification: .announcement, argument: self.error)
            return
        }
        error = nil; submitting = true
        defer { submitting = false }
        if let failure = await send(payload, files) { error = failure }
        else {
            values = ["body": .string(""), "scheduled_at": .null]; files = []
            MobileDraftStore.remove(draftKey)
            focused = false; expanded = false
        }
    }
}

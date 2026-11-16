import SwiftUI
import TaskSquadPortal

/// The inbox's three everyday scopes as a system segmented control. Other
/// statuses and origins are in the filter menu; when one is active it is named
/// here with a way to clear it.
struct MobileInboxScope: View {
    @ObservedObject var model: WorkspaceStore
    private static let scopes = [("All", "all"), ("Needs input", "waiting_input"), ("Running", "running")]
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Show", selection: $model.status) {
                ForEach(Self.scopes, id: \.1) { Text($0.0).tag($0.1) }
                // Keeps the control valid while a status from the filter menu is active.
                if !Self.scopes.map(\.1).contains(model.status) { Text(WorkspaceFilter.label(model.status, any: "")).tag(model.status) }
            }.pickerStyle(.segmented).accessibilityIdentifier("inbox-scope")
            if model.origin != "all" {
                HStack {
                    Text("Origin: " + WorkspaceFilter.label(model.origin, any: "")).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Clear Filters") { model.status = "all"; model.origin = "all" }.font(.caption)
                }
            }
        }.listRowSeparator(.hidden)
    }
}

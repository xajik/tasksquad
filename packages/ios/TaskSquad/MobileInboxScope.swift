import SwiftUI
import TaskSquadPortal

struct MobileInboxScope: View {
    @ObservedObject var model: WorkspaceStore
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    scope("All", value: "all")
                    scope("Needs input", value: "waiting_input")
                    scope("Running", value: "running")
                }
            }
            if !["all", "waiting_input", "running"].contains(model.status) || model.origin != "all" {
                HStack {
                    Text([model.status == "all" ? nil : model.status.replacingOccurrences(of: "_", with: " ").capitalized,
                          model.origin == "all" ? nil : "Origin: " + model.origin.replacingOccurrences(of: "-", with: " ")].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(MobileTheme.mutedForeground)
                    Spacer()
                    Button("Clear filters") { model.status = "all"; model.origin = "all" }.font(.caption).frame(minHeight: 44)
                }
            }
        }.listRowSeparator(.hidden)
    }
    private func scope(_ title: String, value: String) -> some View {
        Button { model.status = value } label: {
            Text(title).font(.subheadline.weight(.medium)).padding(.horizontal, 12).frame(minHeight: 44)
                .foregroundStyle(model.status == value ? MobileTheme.primaryForeground : MobileTheme.foreground)
                .background(model.status == value ? MobileTheme.primary : MobileTheme.muted, in: RoundedRectangle(cornerRadius: MobileTheme.controlRadius))
        }.buttonStyle(.plain).accessibilityIdentifier("scope-" + value)
            .accessibilityAddTraits(model.status == value ? .isSelected : [])
    }
}

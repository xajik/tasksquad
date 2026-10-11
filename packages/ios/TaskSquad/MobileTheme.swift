import SwiftUI
import UIKit

import TaskSquadDesign

typealias MobileTheme = TSQTheme
typealias MobilePrimaryButtonStyle = TSQButtonStyle

struct MobileIcon: View {
    let name: String
    var size: CGFloat = 20
    var body: some View { TSQIcon(name, size: size) }
}

/// A `Menu` row with a Lucide icon.
struct MobileMenuLabel: View {
    let title: String
    let icon: String
    init(_ title: String, icon: String) { self.title = title; self.icon = icon }
    var body: some View { Label { Text(title) } icon: { TSQIcon.image(icon) } }
}

/// The screen's one primary action, floating bottom-trailing: create on
/// workspace lists, reply / comment / edit on a record. Secondary actions live
/// in the navigation bar instead (view options on lists, `…` on records).
/// DESIGN.md §9.1 primary colors, radius-full, §6 elevation-2 because it floats.
struct MobileFAB: View {
    let title: String
    let icon: String
    let identifier: String
    var disabled = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            MobileIcon(name: icon, size: 24)
                .foregroundStyle(MobileTheme.primaryForeground)
                .frame(width: 56, height: 56)
                .background(MobileTheme.primary, in: Circle())
                .shadow(color: .black.opacity(0.10), radius: 3, y: 4)
                .shadow(color: .black.opacity(0.10), radius: 2, y: 2)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(disabled).opacity(disabled ? 0.5 : 1)
        .padding(16)
        .accessibilityLabel(title)
        .accessibilityIdentifier(identifier)
    }
}

/// The `…` navigation-bar menu that holds every secondary record action.
struct MobileMoreMenu<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        Menu { content } label: { MobileIcon(name: "ellipsis").frame(minWidth: 44, minHeight: 44) }
            .accessibilityLabel("More actions")
            .accessibilityIdentifier("more-actions")
    }
}

struct MobileFixtureTypeSize: ViewModifier {
    func body(content: Content) -> some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-large-text") { content.environment(\.dynamicTypeSize, .accessibility3) }
        else { content }
        #else
        content
        #endif
    }
}

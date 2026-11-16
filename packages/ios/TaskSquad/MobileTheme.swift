import SwiftUI
import UIKit

import TaskSquadDesign

typealias MobileTheme = TSQTheme

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

/// The `…` navigation-bar menu that holds every secondary record action.
struct MobileMoreMenu<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        Menu { content } label: { Label("More actions", systemImage: "ellipsis.circle") }
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

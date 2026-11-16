import TaskSquadPortalUI
import TaskSquadDesign
import SwiftUI

typealias Badge = TSQBadge
typealias Card = TSQCard
typealias EmptyState = TSQEmptyState
typealias StatusDot = TSQStatusDot

/// macOS call sites name icons with `LucideIcon`; the shared views take the file name.
extension TSQEmptyState {
    init(icon: LucideIcon, title: String, message: String, @ViewBuilder actions: () -> Actions) {
        self.init(icon: icon.rawValue, title: title, message: message, actions: actions)
    }
}
extension TSQEmptyState where Actions == EmptyView {
    init(icon: LucideIcon, title: String, message: String) { self.init(icon: icon.rawValue, title: title, message: message) }
}

/// Shared destructive callout, inset like the macOS panes expect.
struct ErrorBanner: View {
    let message: String
    var dismiss: (() -> Void)?
    var body: some View { TSQErrorBanner(message, dismiss: dismiss).padding(.horizontal, 16).padding(.vertical, 10) }
}

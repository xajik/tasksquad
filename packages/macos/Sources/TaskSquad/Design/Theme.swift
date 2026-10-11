import AppKit
import SwiftUI

import TaskSquadDesign

typealias Theme = TSQTheme

/// User-selectable appearance (Settings ⌘, and the menu bar menu).
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark
    static let storageKey = "appearance"
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var icon: LucideIcon {
        switch self { case .system: .sunMoon; case .light: .sun; case .dark: .moon }
    }
    @MainActor static var current: AppAppearance {
        UserDefaults.standard.string(forKey: storageKey).flatMap(AppAppearance.init(rawValue:)) ?? .system
    }
    /// Applies app-wide, including sheets, menus, and the terminal views.
    @MainActor func apply() {
        switch self {
        case .system: NSApp.appearance = nil
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        }
    }
}

struct AppearancePicker: View {
    @AppStorage(AppAppearance.storageKey) private var appearance = AppAppearance.system
    var body: some View {
        HStack(spacing: 4) {
            ForEach(AppAppearance.allCases) { option in
                Button { appearance = option } label: {
                    HStack(spacing: 6) { Icon(option.icon, size: 14); Text(option.title).font(.system(size: 12, weight: .medium)) }
                        .padding(.horizontal, 10).frame(height: 28)
                        .foregroundStyle(appearance == option ? Theme.foreground : Theme.mutedForeground)
                        .background(appearance == option ? Theme.background : .clear, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                        .shadow(color: appearance == option ? .black.opacity(0.08) : .clear, radius: 1, y: 1)
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(appearance == option ? .isSelected : [])
            }
        }
        .padding(3).background(Theme.muted, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .onChange(of: appearance) { $0.apply() }
    }
}

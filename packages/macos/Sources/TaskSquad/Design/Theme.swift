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

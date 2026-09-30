import AppKit
import SwiftUI

/// Color tokens. Light mirrors the web portal's slate palette; dark is a soft
/// graphite (not pure black-navy) so long reading sessions stay comfortable.
/// Every text/background pair below meets WCAG AA (4.5:1), including status
/// text on its tinted badge background.
enum Theme {
    static let background = dynamic(light: 0xFFFFFF, dark: 0x17191E)
    /// Sidebar and secondary panes, one step off the content background.
    static let sidebar = dynamic(light: 0xF8FAFC, dark: 0x121418)
    static let foreground = dynamic(light: 0x0F172A, dark: 0xE7E9ED)
    static let muted = dynamic(light: 0xF1F5F9, dark: 0x252830)
    static let mutedForeground = dynamic(light: 0x526074, dark: 0xA0A7B4)
    static let border = dynamic(light: 0xE2E8F0, dark: 0x2E323B)
    static let input = dynamic(light: 0xCBD5E1, dark: 0x3A3F4A)
    static let primary = dynamic(light: 0x0F172A, dark: 0xE7E9ED)
    static let primaryForeground = dynamic(light: 0xF8FAFC, dark: 0x17191E)
    static let destructive = dynamic(light: 0xB91C1C, dark: 0xF87171)
    static let destructiveForeground = dynamic(light: 0xFFFFFF, dark: 0x17191E)
    static let brand = dynamic(light: 0x1D4ED8, dark: 0x7AA7FF)
    static let green = dynamic(light: 0x166534, dark: 0x4ADE80)
    static let amber = dynamic(light: 0x92400E, dark: 0xFBBF24)
    static let red = dynamic(light: 0xB91C1C, dark: 0xF87171)
    /// Status dots are shapes, not text, so they use the brighter signal green.
    static let live = Color(nsColor: .init(srgbRed: 0x22 / 255, green: 0xC5 / 255, blue: 0x5E / 255, alpha: 1))

    /// `--radius: 0.5rem`; buttons and inputs use `rounded-md` (radius - 2).
    static let radius: CGFloat = 8
    static let controlRadius: CGFloat = 6

    private static func rgb(_ value: UInt32) -> NSColor {
        NSColor(srgbRed: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255,
                blue: CGFloat(value & 0xFF) / 255, alpha: 1)
    }
    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        let light = rgb(light), dark = rgb(dark)
        return Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light })
    }
}

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

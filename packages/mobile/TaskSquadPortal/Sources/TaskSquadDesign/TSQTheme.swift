import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Native-first tokens (DESIGN.md "Native platforms"). Surfaces, text and
/// separators are system semantic colours, so materials, vibrancy, Increase
/// Contrast and Dynamic Type all work. Only brand, status and terminal colours
/// are fixed values.
public enum TSQTheme {
    // Surfaces and text: system semantic colours.
    #if os(macOS)
    public static let background = Color(nsColor: .windowBackgroundColor)
    public static let card = Color(nsColor: .controlBackgroundColor)
    public static let muted = Color(nsColor: .quaternarySystemFill)
    public static let subtleForeground = Color(nsColor: .tertiaryLabelColor)
    public static let border = Color(nsColor: .separatorColor)
    #else
    public static let background = Color(uiColor: .systemBackground)
    public static let card = Color(uiColor: .secondarySystemGroupedBackground)
    public static let muted = Color(uiColor: .tertiarySystemFill)
    public static let subtleForeground = Color(uiColor: .tertiaryLabel)
    public static let border = Color(uiColor: .separator)
    #endif
    public static let foreground = Color.primary
    public static let mutedForeground = Color.secondary
    public static let cardForeground = foreground
    public static let popover = card
    public static let popoverForeground = foreground
    public static let input = border
    public static let sidebar = background

    /// App accent. The dark value keeps white text legible on prominent buttons.
    public static let tint = dynamic(light: 0x2563EB, dark: 0x3B82F6)
    public static let primary = tint
    public static let primaryForeground = Color.white
    public static let secondary = muted
    public static let secondaryForeground = foreground
    public static let accent = muted
    public static let accentForeground = foreground
    public static let ring = tint

    // Brand, status and terminal: fixed values.
    public static let brand = dynamic(light: 0x2563EB, dark: 0x7AA7FF)
    public static let ink = dynamic(light: 0x0F1117, dark: 0x0F1117)
    public static let destructive = dynamic(light: 0xB91C1C, dark: 0xF87171)
    public static let destructiveForeground = dynamic(light: 0xF8FAFC, dark: 0x17191E)
    public static let green = dynamic(light: 0x16A34A, dark: 0x4ADE80)
    public static let amber = dynamic(light: 0xD97706, dark: 0xFBBF24)
    public static let red = dynamic(light: 0xDC2626, dark: 0xF87171)
    public static let live = dynamic(light: 0x22C55E, dark: 0x22C55E)
    public static let warning = amber
    public static let scrimModal = Color.black.opacity(0.8)
    public static let scrimDrawer = Color.black.opacity(0.5)

    public static let radius: CGFloat = 8
    public static let controlRadius: CGFloat = 6
    public static let space: CGFloat = 4
    public static let motionFast = 0.15
    public static let motionBase = 0.2
    public static let motionSlow = 0.3

    // Type ramp: system text styles on both platforms, so text follows the
    // user's text-size setting.
    public static let largeTitle: Font = .title.weight(.bold)
    public static let title: Font = .title2.weight(.semibold)
    public static let headline: Font = .headline
    public static let body: Font = .body
    public static let callout: Font = .callout
    public static let caption: Font = .caption
    public static let mono: Font = .body.monospaced()
    public static let monoSmall: Font = .callout.monospaced()
    #if os(macOS)
    public static let controlHeight: CGFloat = 32
    #else
    public static let controlHeight: CGFloat = 44
    #endif
    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        #if os(macOS)
        return Color(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((value >> 16) & 255)/255, green: CGFloat((value >> 8) & 255)/255, blue: CGFloat(value & 255)/255, alpha: 1)
        })
        #else
        return Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255)/255, green: CGFloat((value >> 8) & 255)/255, blue: CGFloat(value & 255)/255, alpha: 1)
        })
        #endif
    }
}

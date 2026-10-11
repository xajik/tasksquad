import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// DESIGN.md tokens. Native destructive contrast and macOS vibrancy exceptions
/// are deliberate. Desktop controls are 28/32pt; touch controls are at least 44pt.
public enum TSQTheme {
    public static let background = dynamic(light: 0xFFFFFF, dark: 0x17191E)
    public static let foreground = dynamic(light: 0x020817, dark: 0xE7E9ED)
    public static let card = dynamic(light: 0xFFFFFF, dark: 0x1C1F25)
    public static let cardForeground = dynamic(light: 0x020817, dark: 0xE7E9ED)
    public static let popover = dynamic(light: 0xFFFFFF, dark: 0x22252C)
    public static let popoverForeground = dynamic(light: 0x020817, dark: 0xE7E9ED)
    public static let primary = dynamic(light: 0x0F172A, dark: 0xFFFFFF)
    public static let primaryForeground = dynamic(light: 0xF8FAFC, dark: 0x17191E)
    public static let secondary = dynamic(light: 0xF1F5F9, dark: 0x252830)
    public static let secondaryForeground = dynamic(light: 0x0F172A, dark: 0xFFFFFF)
    public static let muted = dynamic(light: 0xF1F5F9, dark: 0x252830)
    #if os(macOS)
    public static let mutedForeground = dynamic(light: 0x526074, dark: 0xA0A7B4)
    #else
    public static let mutedForeground = dynamic(light: 0x64748B, dark: 0xA0A7B4)
    #endif
    public static let subtleForeground = dynamic(light: 0x64748B, dark: 0x7A8291)
    public static let accent = dynamic(light: 0xF1F5F9, dark: 0x2A2E37)
    public static let accentForeground = dynamic(light: 0x0F172A, dark: 0xFFFFFF)
    public static let destructive = dynamic(light: 0xB91C1C, dark: 0xF87171)
    public static let destructiveForeground = dynamic(light: 0xF8FAFC, dark: 0x17191E)
    public static let border = dynamic(light: 0xE2E8F0, dark: 0x2E323B)
    #if os(macOS)
    public static let input = dynamic(light: 0xCBD5E1, dark: 0x3A3F4A)
    #else
    public static let input = dynamic(light: 0xE2E8F0, dark: 0x3A3F4A)
    #endif
    public static let ring = dynamic(light: 0x020817, dark: 0xFFFFFF)
    public static let sidebar = dynamic(light: 0xF8FAFC, dark: 0x121418)
    public static let brand = dynamic(light: 0x2563EB, dark: 0x7AA7FF)
    public static let ink = dynamic(light: 0x0F1117, dark: 0x0F1117)
    public static let green = dynamic(light: 0x16A34A, dark: 0x4ADE80)
    public static let amber = dynamic(light: 0xD97706, dark: 0xFBBF24)
    public static let red = dynamic(light: 0xDC2626, dark: 0xF87171)
    public static let live = dynamic(light: 0x22C55E, dark: 0x22C55E)
    public static let radius: CGFloat = 8
    public static let controlRadius: CGFloat = 6
    public static let warning = amber
    public static let space: CGFloat = 4
    public static let motionFast = 0.15
    public static let motionBase = 0.2
    public static let motionSlow = 0.3
    #if os(macOS)
    public static let body: Font = .system(size: 14)
    public static let caption: Font = .system(size: 12)
    public static let controlHeight: CGFloat = 32
    #else
    public static let body: Font = .body
    public static let caption: Font = .caption
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

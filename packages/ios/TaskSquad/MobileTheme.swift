import SwiftUI
import UIKit

/// DESIGN.md roles. iOS keeps Dynamic Type, system form spacing, native
/// alerts/pickers and OS keyboard/photo icons for platform affordances.
enum MobileTheme {
    static let background = color(0xFFFFFF, 0x17191E)
    static let foreground = color(0x020817, 0xE7E9ED)
    static let card = color(0xFFFFFF, 0x1C1F25)
    static let primary = color(0x0F172A, 0xFFFFFF)
    static let primaryForeground = color(0xF8FAFC, 0x17191E)
    static let muted = color(0xF1F5F9, 0x252830)
    static let mutedForeground = color(0x64748B, 0xA0A7B4)
    static let border = color(0xE2E8F0, 0x2E323B)
    static let destructive = color(0xB91C1C, 0xF87171)
    static let warning = color(0x92400E, 0xFBBF24)
    static let brand = color(0x2563EB, 0x7AA7FF)
    static let live = Color(red: 0x22/255, green: 0xC5/255, blue: 0x5E/255)
    static let ink = UIColor(red: 15/255, green: 17/255, blue: 23/255, alpha: 1)
    private static func color(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255)/255, green: CGFloat((value >> 8) & 255)/255, blue: CGFloat(value & 255)/255, alpha: 1)
        })
    }
}

struct MobilePrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.body.weight(.semibold)).padding(.horizontal, 16).frame(minHeight: 44)
            .foregroundStyle(MobileTheme.primaryForeground).background(MobileTheme.primary.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 6))
    }
}

struct MobileIcon: View {
    let name: String
    var size: CGFloat = 20
    var body: some View { Image("TSQ-" + name).renderingMode(.template).resizable().frame(width: size, height: size).accessibilityHidden(true) }
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

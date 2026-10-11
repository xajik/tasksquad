import SwiftUI

/// shadcn `Button` variants from the web portal.
public struct TSQButtonStyle: ButtonStyle {
    public enum Variant { case `default`, secondary, ghost, outline, destructive }
    public enum Size { case `default`, sm, icon }
    var variant: Variant = .default
    var size: Size = .default
    var fullWidth = false
    public init(variant: Variant = .default, size: Size = .default, fullWidth: Bool = false) { self.variant = variant; self.size = size; self.fullWidth = fullWidth }

    public func makeBody(configuration: Configuration) -> some View { StyledButton(configuration: configuration, style: self) }

    private struct StyledButton: View {
        let configuration: Configuration, style: TSQButtonStyle
        @Environment(\.isEnabled) private var enabled
        @State private var hovering = false
        var body: some View {
            configuration.label
                .font(TSQTheme.body.weight(.medium))
                .labelStyle(TSQLabelStyle(spacing: 6))
                .lineLimit(1)
                .padding(.horizontal, style.size == .icon ? 0 : style.size == .sm ? 10 : 14)
                .frame(minWidth: style.size == .icon ? height : nil, maxWidth: style.fullWidth ? .infinity : nil,
                       minHeight: height, alignment: style.fullWidth ? .leading : .center)
                .foregroundStyle(foreground)
                .background(background, in: RoundedRectangle(cornerRadius: TSQTheme.controlRadius, style: .continuous))
                .overlay {
                    if style.variant == .outline {
                        RoundedRectangle(cornerRadius: TSQTheme.controlRadius, style: .continuous).strokeBorder(TSQTheme.input)
                    }
                }
                .contentShape(RoundedRectangle(cornerRadius: TSQTheme.controlRadius, style: .continuous))
                .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.5)
                .onHover { hovering = $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
        }
        private var height: CGFloat {
            #if os(macOS)
            style.size == .sm ? 28 : 32
            #else
            44
            #endif
        }
        private var foreground: Color {
            switch style.variant {
            case .default: TSQTheme.primaryForeground
            case .destructive: TSQTheme.destructiveForeground
            default: TSQTheme.foreground
            }
        }
        private var background: Color {
            let hover = hovering && enabled
            switch style.variant {
            case .default: return TSQTheme.primary.opacity(hover ? 0.9 : 1)
            case .destructive: return TSQTheme.destructive.opacity(hover ? 0.9 : 1)
            case .secondary: return TSQTheme.muted.opacity(hover ? 0.8 : 1)
            case .ghost, .outline: return hover ? TSQTheme.muted : .clear
            }
        }
    }
}

public extension ButtonStyle where Self == TSQButtonStyle {
    static var tsqPrimary: TSQButtonStyle { .init() }
    static var tsqSecondary: TSQButtonStyle { .init(variant: .secondary) }
    static var tsqOutline: TSQButtonStyle { .init(variant: .outline) }
    static var tsqGhost: TSQButtonStyle { .init(variant: .ghost) }
    static var tsqDestructive: TSQButtonStyle { .init(variant: .destructive) }
    static var tsqIcon: TSQButtonStyle { .init(variant: .ghost, size: .icon) }
    static func tsq(_ variant: TSQButtonStyle.Variant, size: TSQButtonStyle.Size = .sm) -> TSQButtonStyle { .init(variant: variant, size: size) }
}

public struct TSQLabelStyle: LabelStyle {
    var spacing: CGFloat = 8
    public init(spacing: CGFloat = 8) { self.spacing = spacing }
    public func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: spacing) { configuration.icon; configuration.title }
    }
}


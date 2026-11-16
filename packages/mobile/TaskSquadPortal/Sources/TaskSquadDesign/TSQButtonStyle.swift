import SwiftUI

/// Maps the app's button roles onto system button styles, so buttons get the
/// platform's metrics, focus ring, pressed and disabled states, and accent colour.
public struct TSQButtonStyle: PrimitiveButtonStyle {
    public enum Variant { case `default`, secondary, ghost, outline, destructive }
    public enum Size { case `default`, sm, icon }
    var variant: Variant = .default
    var size: Size = .default
    var fullWidth = false
    public init(variant: Variant = .default, size: Size = .default, fullWidth: Bool = false) { self.variant = variant; self.size = size; self.fullWidth = fullWidth }

    public func makeBody(configuration: Configuration) -> some View {
        styled(Button(configuration)).controlSize(controlSize)
    }
    @ViewBuilder private func styled(_ button: Button<PrimitiveButtonStyleConfiguration.Label>) -> some View {
        switch variant {
        case .default: button.buttonStyle(.borderedProminent)
        case .destructive: button.buttonStyle(.borderedProminent).tint(TSQTheme.destructive)
        case .secondary, .outline: button.buttonStyle(.bordered)
        case .ghost: button.buttonStyle(.borderless)
        }
    }
    private var controlSize: ControlSize {
        #if os(macOS)
        size == .default ? .large : .regular
        #else
        size == .default ? .large : .regular
        #endif
    }
}

public extension PrimitiveButtonStyle where Self == TSQButtonStyle {
    static var tsqPrimary: TSQButtonStyle { .init() }
    static var tsqSecondary: TSQButtonStyle { .init(variant: .secondary) }
    static var tsqOutline: TSQButtonStyle { .init(variant: .outline, size: .sm) }
    static var tsqGhost: TSQButtonStyle { .init(variant: .ghost, size: .sm) }
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

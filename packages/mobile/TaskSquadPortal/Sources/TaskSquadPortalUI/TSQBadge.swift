import SwiftUI
import TaskSquadPortal
import TaskSquadDesign

/// shadcn `Badge`; also used for task status, like the web inbox.
public struct TSQBadge: View {
    public enum Variant { case `default`, secondary, outline, success, warning, danger }
    let text: String
    var variant: Variant = .secondary
    public init(_ text: String, variant: Variant = .secondary) { self.text = text; self.variant = variant }
    public init(status: String) {
        let presentation = StatusPresentation(status)
        text = presentation.label
        switch presentation.variant {
        case .default: variant = .default
        case .secondary: variant = .secondary
        case .destructive: variant = .danger
        case .outline: variant = .outline
        }
    }

    public var body: some View {
        Text(text).font(TSQTheme.caption.weight(.semibold)).lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .foregroundStyle(foreground).background(background, in: Capsule())
            .overlay { if variant == .outline { Capsule().strokeBorder(TSQTheme.border) } }
    }
    private var foreground: Color {
        switch variant {
        case .default: TSQTheme.primaryForeground
        case .secondary, .outline: TSQTheme.foreground
        case .success: TSQTheme.green
        case .warning: TSQTheme.amber
        case .danger: TSQTheme.destructiveForeground
        }
    }
    private var background: Color {
        switch variant {
        case .default: TSQTheme.primary
        case .secondary: TSQTheme.muted
        case .outline: .clear
        case .success: TSQTheme.green.opacity(0.12)
        case .warning: TSQTheme.amber.opacity(0.14)
        case .danger: TSQTheme.destructive
        }
    }
}


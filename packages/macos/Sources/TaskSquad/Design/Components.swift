import SwiftUI

/// shadcn `Button` variants from the web portal.
struct TSQButtonStyle: ButtonStyle {
    enum Variant { case `default`, secondary, ghost, outline, destructive }
    enum Size { case `default`, sm, icon }
    var variant: Variant = .default
    var size: Size = .default
    var fullWidth = false

    func makeBody(configuration: Configuration) -> some View { StyledButton(configuration: configuration, style: self) }

    private struct StyledButton: View {
        let configuration: Configuration, style: TSQButtonStyle
        @Environment(\.isEnabled) private var enabled
        @State private var hovering = false
        var body: some View {
            configuration.label
                .font(.system(size: style.size == .sm ? 12 : 13, weight: .medium))
                .labelStyle(TSQLabelStyle(spacing: 6))
                .lineLimit(1)
                .padding(.horizontal, style.size == .icon ? 0 : style.size == .sm ? 10 : 14)
                .frame(minWidth: style.size == .icon ? height : nil, maxWidth: style.fullWidth ? .infinity : nil,
                       minHeight: height, alignment: style.fullWidth ? .leading : .center)
                .foregroundStyle(foreground)
                .background(background, in: RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous))
                .overlay {
                    if style.variant == .outline {
                        RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).strokeBorder(Theme.input)
                    }
                }
                .contentShape(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous))
                .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.5)
                .onHover { hovering = $0 }
                .animation(.easeOut(duration: 0.12), value: hovering)
        }
        private var height: CGFloat { style.size == .sm ? 28 : 32 }
        private var foreground: Color {
            switch style.variant {
            case .default: Theme.primaryForeground
            case .destructive: Theme.destructiveForeground
            default: Theme.foreground
            }
        }
        private var background: Color {
            let hover = hovering && enabled
            switch style.variant {
            case .default: return Theme.primary.opacity(hover ? 0.9 : 1)
            case .destructive: return Theme.destructive.opacity(hover ? 0.9 : 1)
            case .secondary: return Theme.muted.opacity(hover ? 0.8 : 1)
            case .ghost, .outline: return hover ? Theme.muted : .clear
            }
        }
    }
}

extension ButtonStyle where Self == TSQButtonStyle {
    static var tsqPrimary: TSQButtonStyle { .init() }
    static var tsqSecondary: TSQButtonStyle { .init(variant: .secondary) }
    static var tsqOutline: TSQButtonStyle { .init(variant: .outline) }
    static var tsqGhost: TSQButtonStyle { .init(variant: .ghost) }
    static var tsqDestructive: TSQButtonStyle { .init(variant: .destructive) }
    static var tsqIcon: TSQButtonStyle { .init(variant: .ghost, size: .icon) }
    static func tsq(_ variant: TSQButtonStyle.Variant, size: TSQButtonStyle.Size = .sm) -> TSQButtonStyle { .init(variant: variant, size: size) }
}

struct TSQLabelStyle: LabelStyle {
    var spacing: CGFloat = 8
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: spacing) { configuration.icon; configuration.title }
    }
}

/// Web sidebar item: `Button variant={selected ? 'secondary' : 'ghost'} className="w-full justify-start"`.
struct SidebarItem: View {
    let icon: LucideIcon, title: String
    var selected = false
    var muted = false
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Icon(icon)
                Text(title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).frame(height: 32)
            .foregroundStyle(muted && !selected ? Theme.mutedForeground : Theme.foreground)
            .background(selected ? Theme.muted : hovering ? Theme.muted.opacity(0.6) : .clear,
                        in: RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).onHover { hovering = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct SidebarHeader: View {
    let title: String
    var body: some View {
        Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).tracking(0.6)
            .foregroundStyle(Theme.mutedForeground).padding(.horizontal, 10).padding(.top, 14).padding(.bottom, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// shadcn `Badge`; also used for task status, like the web inbox.
struct Badge: View {
    enum Variant { case `default`, secondary, outline, success, warning, danger }
    let text: String
    var variant: Variant = .secondary
    init(_ text: String, variant: Variant = .secondary) { self.text = text; self.variant = variant }
    init(status: String) {
        text = status.replacingOccurrences(of: "_", with: " ").capitalized
        switch status {
        case "running", "done", "completed", "online", "active", "approved": variant = .success
        case "failed", "rejected", "error": variant = .danger
        case "waiting_input", "wrapping_up", "paused", "scheduled": variant = .warning
        default: variant = .secondary
        }
    }
    var body: some View {
        Text(text).font(.system(size: 11, weight: .semibold)).lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .foregroundStyle(foreground).background(background, in: Capsule())
            .overlay { if variant == .outline { Capsule().strokeBorder(Theme.border) } }
    }
    private var foreground: Color {
        switch variant {
        case .default: Theme.primaryForeground
        case .secondary, .outline: Theme.foreground
        case .success: Theme.green
        case .warning: Theme.amber
        case .danger: Theme.red
        }
    }
    private var background: Color {
        switch variant {
        case .default: Theme.primary
        case .secondary: Theme.muted
        case .outline: .clear
        case .success: Theme.green.opacity(0.12)
        case .warning: Theme.amber.opacity(0.14)
        case .danger: Theme.red.opacity(0.12)
        }
    }
}

struct StatusDot: View {
    var active: Bool
    var color: Color? = nil
    var size: CGFloat = 8
    @State private var pulse = false
    var body: some View {
        Circle().fill(color ?? (active ? Theme.live : Theme.mutedForeground)).frame(width: size, height: size)
            .opacity(active && pulse ? 0.45 : 1)
            .animation(active ? .easeInOut(duration: 1).repeatForever(autoreverses: true) : .default, value: pulse)
            .onAppear { pulse = active }
            .onChange(of: active) { pulse = $0 }
    }
}

struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder let content: Content
    var body: some View {
        content.padding(padding)
            .background(Theme.background, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.border))
    }
}

struct EmptyState<Actions: View>: View {
    let icon: LucideIcon, title: String, message: String
    @ViewBuilder var actions: Actions
    var body: some View {
        VStack(spacing: 10) {
            Icon(icon, size: 22).foregroundStyle(Theme.mutedForeground)
                .frame(width: 48, height: 48).background(Theme.muted, in: Circle())
                .padding(.bottom, 4)
            Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.foreground)
            Text(message).font(.system(size: 13)).foregroundStyle(Theme.mutedForeground)
                .multilineTextAlignment(.center).frame(maxWidth: 380)
            actions.padding(.top, 6)
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
extension EmptyState where Actions == EmptyView {
    init(icon: LucideIcon, title: String, message: String) { self.init(icon: icon, title: title, message: message) { EmptyView() } }
}

struct ErrorBanner: View {
    let message: String
    var dismiss: (() -> Void)?
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Icon(.circleAlert).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
            Text(message).font(.system(size: 13)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            if let dismiss {
                Button(action: dismiss) { Icon(.x, size: 14) }.buttonStyle(.plain).help("Dismiss")
            }
        }
        .foregroundStyle(Theme.destructive)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.destructive.opacity(0.08), in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.destructive.opacity(0.3)))
        .padding(.horizontal, 16).padding(.vertical, 10)
    }
}

/// Web `Input` with a leading search icon.
struct SearchField: View {
    let prompt: String
    @Binding var text: String
    init(_ prompt: String, text: Binding<String>) { self.prompt = prompt; _text = text }
    var body: some View {
        HStack(spacing: 6) {
            Icon(.search, size: 14).foregroundStyle(Theme.mutedForeground)
            TextField(prompt, text: $text).textFieldStyle(.plain).font(.system(size: 13))
            if !text.isEmpty {
                Button { text = "" } label: { Icon(.x, size: 12) }.buttonStyle(.plain).foregroundStyle(Theme.mutedForeground)
            }
        }
        .padding(.horizontal, 10).frame(height: 32)
        .background(Theme.background, in: RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).strokeBorder(Theme.input))
    }
}

/// A selectable list row styled like the web's inbox rows.
struct RowBackground: ViewModifier {
    var selected: Bool
    @State private var hovering = false
    func body(content: Content) -> some View {
        content.padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Theme.muted : hovering ? Theme.muted.opacity(0.5) : .clear,
                        in: RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous))
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
    }
}
extension View {
    func rowBackground(selected: Bool) -> some View { modifier(RowBackground(selected: selected)) }
    /// A 1px `border-border` divider on one edge.
    func edgeBorder(_ edge: Edge) -> some View {
        overlay(alignment: edge == .top ? .top : edge == .bottom ? .bottom : edge == .leading ? .leading : .trailing) {
            Rectangle().fill(Theme.border)
                .frame(width: edge == .leading || edge == .trailing ? 1 : nil, height: edge == .top || edge == .bottom ? 1 : nil)
        }
    }
}

/// Selectable plain list used in place of `List` so rows look like the web.
struct TSQList<Item, ID: Hashable, Row: View>: View {
    let items: [Item]
    let id: KeyPath<Item, ID>
    @Binding var selection: ID?
    @ViewBuilder let row: (Item) -> Row
    init(items: [Item], id: KeyPath<Item, ID>, selection: Binding<ID?>, @ViewBuilder row: @escaping (Item) -> Row) {
        self.items = items; self.id = id; _selection = selection; self.row = row
    }
    var body: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(items, id: id) { item in
                    let selected = selection == item[keyPath: id]
                    Button { selection = item[keyPath: id] } label: { row(item).rowBackground(selected: selected) }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }.padding(8)
        }
    }
}
extension TSQList where Item: Identifiable, ID == Item.ID {
    init(items: [Item], selection: Binding<ID?>, @ViewBuilder row: @escaping (Item) -> Row) {
        self.init(items: items, id: \.id, selection: selection, row: row)
    }
}

struct PageHeader<Trailing: View>: View {
    let title: String
    var subtitle: String? = nil
    @ViewBuilder var trailing: Trailing
    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 20, weight: .bold)).foregroundStyle(Theme.foreground)
                if let subtitle { Text(subtitle).font(.system(size: 13)).foregroundStyle(Theme.mutedForeground) }
            }
            Spacer(minLength: 12)
            trailing
        }.padding(.horizontal, 20).padding(.vertical, 14)
    }
}

/// shadcn `Select`: a bordered trigger with a chevron that opens a list of
/// options, used for compact filters instead of the gray native popup button.
struct SelectMenu<Value: Hashable>: View {
    let title: String
    @Binding var selection: Value
    let options: [(value: Value, label: String)]
    var minWidth: CGFloat = 112
    @State private var open = false
    @State private var hovering = false

    private var current: String { options.first { $0.value == selection }?.label ?? title }

    var body: some View {
        Button { open.toggle() } label: {
            HStack(spacing: 6) {
                Text(current).font(.system(size: 12)).foregroundStyle(Theme.foreground).lineLimit(1)
                Spacer(minLength: 4)
                Icon(.chevronDown, size: 12).foregroundStyle(Theme.mutedForeground)
            }
            .padding(.horizontal, 9).frame(minWidth: minWidth, minHeight: 28)
            .background(hovering ? Theme.muted.opacity(0.6) : Theme.background,
                        in: RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous)
                .strokeBorder(open ? Theme.mutedForeground.opacity(0.6) : Theme.input))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).fixedSize()
        .onHover { hovering = $0 }
        .help(title)
        .accessibilityLabel("\(title): \(current)")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                    SelectRow(label: option.label, selected: option.value == selection) {
                        selection = option.value; open = false
                    }
                }
            }
            .padding(4).frame(minWidth: max(minWidth, 150)).background(Theme.background)
        }
    }
}

private struct SelectRow: View {
    let label: String, selected: Bool
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Icon(.check, size: 12).opacity(selected ? 1 : 0)
                Text(label).font(.system(size: 12)).lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.foreground)
            .padding(.horizontal, 8).frame(height: 26)
            .background(hovering ? Theme.muted : .clear, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).onHover { hovering = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

import TaskSquadPortalUI
import TaskSquadDesign
import SwiftUI

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

typealias Badge = TSQBadge
typealias Card = TSQCard
typealias EmptyState = TSQEmptyState
typealias StatusDot = TSQStatusDot
typealias PageHeader = TSQPageHeader

/// macOS call sites name icons with `LucideIcon`; the shared views take the file name.
extension TSQEmptyState {
    init(icon: LucideIcon, title: String, message: String, @ViewBuilder actions: () -> Actions) {
        self.init(icon: icon.rawValue, title: title, message: message, actions: actions)
    }
}
extension TSQEmptyState where Actions == EmptyView {
    init(icon: LucideIcon, title: String, message: String) { self.init(icon: icon.rawValue, title: title, message: message) }
}
extension TSQPageHeader {
    init(title: String, subtitle: String? = nil, @ViewBuilder trailing: () -> Trailing) { self.init(title, subtitle: subtitle, trailing: trailing) }
}

/// Shared destructive callout, inset like the macOS panes expect.
struct ErrorBanner: View {
    let message: String
    var dismiss: (() -> Void)?
    var body: some View { TSQErrorBanner(message, dismiss: dismiss).padding(.horizontal, 16).padding(.vertical, 10) }
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

import SwiftUI
import TaskSquadDesign

/// Domain-free building blocks shared by the iOS and macOS clients. Text uses
/// the `TSQTheme` type ramp (system text styles) on both platforms.

/// Grouped `card` surface with the 8pt content radius.
public struct TSQCard<Content: View>: View {
    var padding: CGFloat
    let content: Content
    public init(padding: CGFloat = 16, @ViewBuilder content: () -> Content) { self.padding = padding; self.content = content() }
    public var body: some View {
        content.padding(padding)
            .background(TSQTheme.card, in: RoundedRectangle(cornerRadius: TSQTheme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: TSQTheme.radius, style: .continuous).strokeBorder(TSQTheme.border))
    }
}

/// The system empty state (`ContentUnavailableView`) with an app icon.
public struct TSQEmptyState<Actions: View>: View {
    let icon: String, title: String, message: String
    let actions: Actions
    public init(icon: String, title: String, message: String, @ViewBuilder actions: () -> Actions) {
        self.icon = icon; self.title = title; self.message = message; self.actions = actions()
    }
    public var body: some View {
        ContentUnavailableView {
            Label { Text(title) } icon: { TSQIcon(icon, size: 40) }
        } description: { Text(message) } actions: { actions }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
public extension TSQEmptyState where Actions == EmptyView {
    init(icon: String, title: String, message: String) { self.init(icon: icon, title: title, message: message) { EmptyView() } }
}

/// Destructive callout: tinted fill, border, and an optional dismiss button.
public struct TSQErrorBanner: View {
    let message: String
    let identifier: String?
    let dismiss: (() -> Void)?
    public init(_ message: String, identifier: String? = nil, dismiss: (() -> Void)? = nil) { self.message = message; self.identifier = identifier; self.dismiss = dismiss }
    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            TSQIcon("circle-alert").alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
            Text(message).font(TSQTheme.body).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier(identifier ?? "")
            if let dismiss {
                Button(action: dismiss) { TSQIcon("x", size: 14).frame(minWidth: 28, minHeight: 28).contentShape(Rectangle()) }.buttonStyle(.plain).accessibilityLabel("Dismiss")
            }
        }
        .foregroundStyle(TSQTheme.destructive)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(TSQTheme.destructive.opacity(0.08), in: RoundedRectangle(cornerRadius: TSQTheme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: TSQTheme.radius, style: .continuous).strokeBorder(TSQTheme.destructive.opacity(0.3)))
    }
}

/// Live/offline indicator; pulses while active. Status is never color alone,
/// so pair it with a label.
public struct TSQStatusDot: View {
    let active: Bool
    let color: Color?
    let size: CGFloat
    @State private var pulse = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    public init(active: Bool, color: Color? = nil, size: CGFloat = 8) { self.active = active; self.color = color; self.size = size }
    public var body: some View {
        Circle().fill(color ?? (active ? TSQTheme.live : TSQTheme.mutedForeground)).frame(width: size, height: size)
            .opacity(active && pulse ? 0.45 : 1)
            .animation(active ? .easeInOut(duration: 1).repeatForever(autoreverses: true) : .default, value: pulse)
            .onAppear { pulse = active && !reduceMotion }
            .onChange(of: active) { _, value in pulse = value && !reduceMotion }
            .accessibilityHidden(true)
    }
}

/// Section title with optional subtitle and trailing controls.
public struct TSQPageHeader<Trailing: View>: View {
    let title: String
    let subtitle: String?
    let trailing: Trailing
    public init(_ title: String, subtitle: String? = nil, @ViewBuilder trailing: () -> Trailing) { self.title = title; self.subtitle = subtitle; self.trailing = trailing() }
    public var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.title3.weight(.bold)).foregroundStyle(TSQTheme.foreground).accessibilityAddTraits(.isHeader)
                if let subtitle { Text(subtitle).font(TSQTheme.body).foregroundStyle(TSQTheme.mutedForeground) }
            }
            Spacer(minLength: 12)
            trailing
        }.padding(.horizontal, 20).padding(.vertical, 14)
    }
}

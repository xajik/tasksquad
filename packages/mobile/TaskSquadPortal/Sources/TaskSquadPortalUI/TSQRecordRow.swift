import SwiftUI
import TaskSquadPortal
import TaskSquadDesign

/// One record in a list: title, status, who or what it belongs to, and when.
/// The same row on macOS, iPadOS and iOS; the system list supplies selection,
/// separators and disclosure indicators.
public struct TSQRecordRow: View {
    let title: String
    let status: String
    let paused: Bool
    let detail: String?
    let summary: String?
    let tags: [String]
    let date: Date?
    public init(title: String, status: String = "", paused: Bool = false, detail: String? = nil, summary: String? = nil, tags: [String] = [], date: Date? = nil) {
        self.title = title; self.status = status; self.paused = paused; self.detail = detail; self.summary = summary; self.tags = tags; self.date = date
    }
    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).font(TSQTheme.body.weight(.medium)).lineLimit(2)
                Spacer(minLength: 4)
                if let date { Text(date, format: .relative(presentation: .named)).font(TSQTheme.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            if !status.isEmpty || paused || detail != nil {
                HStack(spacing: 6) {
                    if !status.isEmpty { TSQBadge(status: status) }
                    if paused { TSQBadge("Paused", variant: .warning) }
                    if let detail { Text(detail).font(TSQTheme.caption).foregroundStyle(.secondary).lineLimit(1) }
                }
            }
            if let summary, !summary.isEmpty { Text(summary).font(TSQTheme.callout).foregroundStyle(.secondary).lineLimit(2) }
            if !tags.isEmpty { Text(tags.map { "#" + $0 }.joined(separator: " ")).font(TSQTheme.caption).foregroundStyle(.secondary).lineLimit(1) }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

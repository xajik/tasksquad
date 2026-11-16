import SwiftUI
import Charts
import TaskSquadPortal

/// Project totals, a daily chart and per-agent results for the last 30 days.
struct MobileAnalytics: View {
    @ObservedObject var model: WorkspaceStore
    fileprivate static func day(_ text: String) -> Date { (try? Date(text, strategy: .iso8601.year().month().day())) ?? .distantPast }
    var body: some View {
        Section("Last 30 days") {
            if let record = model.records.first {
                ForEach(["created", "done", "failed", "in_progress", "scheduled"], id: \.self) { key in
                    LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: String(Int(record.value["totals"]?[key]?.number ?? 0)))
                }
                if !record.records("daily").isEmpty {
                    Chart(record.records("daily").indices, id: \.self) { index in
                        let day = record.records("daily")[index]
                        BarMark(x: .value("Day", Self.day(day.text("date")), unit: .day), y: .value("Created", day.number("created")))
                            .foregroundStyle(MobileTheme.tint)
                    }
                    .chartXAxis { AxisMarks(values: .stride(by: .day, count: 7)) { AxisGridLine(); AxisValueLabel(format: .dateTime.month(.abbreviated).day()) } }
                    .frame(height: 180).accessibilityLabel("Tasks created by day")
                }
                ForEach(record.records("agents").indices, id: \.self) { index in
                    let agent = record.records("agents")[index]
                    LabeledContent(agent.title, value: "\(Int(agent.number("done"))) completed / \(Int(agent.number("tasks"))) tasks")
                }
                ForEach(["turns", "input_tokens", "output_tokens", "tool_calls", "tool_errors"], id: \.self) { key in
                    LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: String(Int(record.value["usage"]?[key]?.number ?? 0)))
                }
            }
        }
    }
}

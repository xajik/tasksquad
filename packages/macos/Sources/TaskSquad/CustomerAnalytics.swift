import Charts
import SwiftUI
import TaskSquadCore

/// Project statistics, mirroring the web Analytics page (GET /teams/:id/stats).
struct CustomerAnalytics: View {
    @ObservedObject var model: CustomerWorkspaceModel
    @State private var range: StatsRange = .month
    @State private var agentID = ""
    @State private var stats: CustomerRecord?
    @State private var loading = false
    @State private var failure: String?
    @State private var hoveredDay: String?

    init(model: CustomerWorkspaceModel, initialStats: CustomerRecord? = nil) {
        self.model = model
        _stats = State(initialValue: initialStats)
    }

    enum StatsRange: String, CaseIterable, Identifiable {
        case day = "24h", week = "7 days", month = "30 days", quarter = "90 days"
        var id: String { rawValue }
        var seconds: Double { switch self { case .day: 86_400; case .week: 7 * 86_400; case .month: 30 * 86_400; case .quarter: 90 * 86_400 } }
    }

    // Validated with the dataviz palette checker (CVD-safe; green/red is not):
    // light blue-600/red-600, dark blue-500/red-500.
    private static let done = Color(nsColor: .init(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(srgbRed: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255, alpha: 1) : NSColor(srgbRed: 0x25 / 255, green: 0x63 / 255, blue: 0xEB / 255, alpha: 1) })
    private static let failed = Color(nsColor: .init(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(srgbRed: 0xEF / 255, green: 0x44 / 255, blue: 0x44 / 255, alpha: 1) : NSColor(srgbRed: 0xDC / 255, green: 0x26 / 255, blue: 0x26 / 255, alpha: 1) })

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                filters
                if let failure { ErrorBanner(message: failure) { self.failure = nil }.padding(.horizontal, -16) }
                if let stats { content(stats) }
                else if loading { ProgressView().frame(maxWidth: .infinity).padding(40) }
            }.padding(20).frame(maxWidth: 1100, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: "\(model.teamID):\(range.rawValue):\(agentID)") { await load() }
    }

    private var filters: some View {
        HStack(spacing: 10) {
            Picker("Range", selection: $range) { ForEach(StatsRange.allCases) { Text($0.rawValue).tag($0) } }
                .pickerStyle(.segmented).labelsHidden().frame(width: 320)
            Picker("Agent", selection: $agentID) {
                Text("All agents").tag("")
                ForEach(model.agents) { Text($0.title).tag($0.id) }
            }.pickerStyle(.menu).labelsHidden().fixedSize()
            Spacer()
            if loading { ProgressView().controlSize(.small) }
            Button { Task { await load() } } label: { Icon(.refreshCw) }.buttonStyle(.tsqIcon).foregroundStyle(Theme.mutedForeground).help("Refresh")
        }
    }

    @ViewBuilder private func content(_ stats: CustomerRecord) -> some View {
        let totals = CustomerRecord(stats.value["totals"] ?? .null), usage = CustomerRecord(stats.value["usage"] ?? .null)
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
            tile("Tasks created", count(totals.number("created")), "\(Int(totals.number("started"))) started")
            tile("Done", count(totals.number("done")))
            tile("Failed", count(totals.number("failed")), totals.number("cancelled") > 0 ? "\(Int(totals.number("cancelled"))) cancelled" : nil)
            tile("Success rate", percent(totals.value["success_rate"]), "done ÷ (done + failed)")
            tile("Median time to done", duration(totals.value["median_completion_ms"]?.number))
            tile("In progress", count(totals.number("in_progress")))
            tile("Tool calls", count(usage.number("tool_calls")), usage.number("tool_errors") > 0 ? "\(Int(usage.number("tool_errors"))) errors" : nil)
            tile("Tokens", count(usage.number("input_tokens") + usage.number("output_tokens")),
                 "\(count(usage.number("input_tokens"))) in · \(count(usage.number("output_tokens"))) out")
            tile("Agent active time", duration(usage.number("active_ms")), "\(Int(usage.number("sessions_reported"))) sessions reported")
        }
        if usage.number("sessions_reported") == 0 {
            Text("Tool, skill and token usage appears once agents run on a daemon version that sends session reports.")
                .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
        }
        dailyChart(stats.records("daily"))
        HStack(alignment: .top, spacing: 12) {
            ranked("Most used tools", stats.records("tools"), empty: "No tool usage reported in this range.")
            ranked("Skills used", stats.records("skills"), empty: "No skills invoked in this range.")
        }
        agentTable(stats.records("agents"))
    }

    private func dailyChart(_ days: [CustomerRecord]) -> some View {
        section("Completed tasks per day") {
            HStack(spacing: 14) {
                legend("Done", Self.done); legend("Failed", Self.failed)
                Spacer()
                if let day = days.first(where: { $0.text("date") == hoveredDay }) {
                    Text("\(shortDate(day.text("date"))): \(Int(day.number("created"))) created · \(Int(day.number("done"))) done · \(Int(day.number("failed"))) failed")
                        .font(.system(size: 12)).foregroundStyle(Theme.foreground)
                }
            }.font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
            Chart {
                ForEach(Array(days.enumerated()), id: \.offset) { _, day in
                    BarMark(x: .value("Day", day.text("date")), y: .value("Tasks", day.number("done")))
                        .foregroundStyle(Self.done).cornerRadius(2)
                    BarMark(x: .value("Day", day.text("date")), y: .value("Tasks", day.number("failed")))
                        .foregroundStyle(Self.failed).cornerRadius(2)
                }
            }
            .chartXAxis {
                AxisMarks(values: days.count > 1 ? [days.first!.text("date"), days.last!.text("date")] : days.map { $0.text("date") }) { value in
                    AxisValueLabel { Text(shortDate(value.as(String.self) ?? "")) }
                }
            }
            .chartYAxis { AxisMarks(position: .leading) { _ in AxisGridLine().foregroundStyle(Theme.border); AxisValueLabel() } }
            .chartOverlay { proxy in
                GeometryReader { geometry in
                    Rectangle().fill(.clear).contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let point):
                                let x = point.x - geometry[proxy.plotAreaFrame].origin.x
                                hoveredDay = proxy.value(atX: x, as: String.self)
                            case .ended: hoveredDay = nil
                            }
                        }
                }
            }
            .frame(height: 180)
            .accessibilityLabel("Done and failed tasks per day")
        }
    }

    private func ranked(_ title: String, _ items: [CustomerRecord], empty: String) -> some View {
        let maximum = max(items.map { $0.number("count") }.max() ?? 1, 1)
        return section(title) {
            if items.isEmpty {
                Text(empty).font(.system(size: 13)).foregroundStyle(Theme.mutedForeground).frame(maxWidth: .infinity).padding(.vertical, 20)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(items.prefix(12).enumerated()), id: \.offset) { _, item in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(item.text("name")).font(.system(size: 12, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                                Spacer(); Text(count(item.number("count"))).font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).monospacedDigit()
                            }
                            GeometryReader { geometry in
                                Capsule().fill(Theme.muted).overlay(alignment: .leading) {
                                    Capsule().fill(Self.done).frame(width: geometry.size.width * item.number("count") / maximum)
                                }
                            }.frame(height: 6)
                        }
                    }
                }
            }
        }.frame(maxWidth: .infinity)
    }

    private func agentTable(_ agents: [CustomerRecord]) -> some View {
        section("Agent performance") {
            if agents.isEmpty {
                Text("No tasks in this range.").font(.system(size: 13)).foregroundStyle(Theme.mutedForeground).frame(maxWidth: .infinity).padding(.vertical, 20)
            } else {
                Grid(alignment: .trailing, horizontalSpacing: 16, verticalSpacing: 8) {
                    GridRow {
                        Text("Agent").gridColumnAlignment(.leading)
                        Text("Tasks"); Text("Done"); Text("Failed"); Text("Success"); Text("Median time"); Text("👍 / 👎"); Text("Tool calls"); Text("Tokens")
                    }.font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.mutedForeground)
                    ForEach(Array(agents.enumerated()), id: \.offset) { _, agent in
                        Divider().gridCellUnsizedAxes(.horizontal)
                        GridRow {
                            Text(agent.text("name")).fontWeight(.medium)
                            Text("\(Int(agent.number("tasks")))"); Text("\(Int(agent.number("done")))"); Text("\(Int(agent.number("failed")))")
                            Text(percent(agent.value["success_rate"])); Text(duration(agent.value["median_completion_ms"]?.number))
                            Text("\(Int(agent.number("grades_up"))) / \(Int(agent.number("grades_down")))")
                            Text(count(agent.number("tool_calls"))); Text(count(agent.number("input_tokens") + agent.number("output_tokens")))
                        }.font(.system(size: 13)).monospacedDigit()
                    }
                }
            }
        }
    }

    // MARK: Building blocks

    private func tile(_ label: String, _ value: String, _ hint: String? = nil) -> some View {
        Card(padding: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.mutedForeground)
                Text(value).font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.foreground).monospacedDigit()
                Text(hint ?? " ").font(.system(size: 11)).foregroundStyle(Theme.mutedForeground)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.foreground)
                content()
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func legend(_ label: String, _ color: Color) -> some View {
        HStack(spacing: 5) { RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 10, height: 10); Text(label) }
    }

    @MainActor private static let compact: NumberFormatter = {
        let formatter = NumberFormatter(); formatter.numberStyle = .decimal; formatter.maximumFractionDigits = 1; return formatter
    }()
    private func count(_ value: Double) -> String {
        switch value {
        case 1_000_000...: "\(Self.compact.string(from: NSNumber(value: value / 1_000_000)) ?? "")M"
        case 10_000...: "\(Self.compact.string(from: NSNumber(value: value / 1_000)) ?? "")K"
        default: Self.compact.string(from: NSNumber(value: value)) ?? "\(Int(value))"
        }
    }
    private func percent(_ value: JSONValue?) -> String { value?.number.map { "\(Int(($0 * 100).rounded()))%" } ?? "—" }
    private func duration(_ milliseconds: Double?) -> String {
        guard let milliseconds else { return "—" }
        let seconds = Int((milliseconds / 1000).rounded())
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m \(seconds % 60)s" }
        let hours = minutes / 60
        return hours < 24 ? "\(hours)h \(minutes % 60)m" : "\(hours / 24)d \(hours % 24)h"
    }
    private func shortDate(_ date: String) -> String {
        guard let parsed = ISO8601DateFormatter.dateOnly.date(from: date) else { return date }
        return parsed.formatted(.dateTime.month(.abbreviated).day())
    }

    private func load() async {
        let team = model.teamID
        guard !team.isEmpty else { return }
        loading = true; defer { loading = false }
        let to = Date().timeIntervalSince1970 * 1000, from = to - range.seconds * 1000
        var query = ["from": String(Int(from)), "to": String(Int(to)), "tz": String(-TimeZone.current.secondsFromGMT() / 60)]
        if !agentID.isEmpty { query["agent_id"] = agentID }
        do {
            let response = try await model.api().request(["teams", team, "stats"], query: query)
            guard team == model.teamID, !Task.isCancelled else { return }
            stats = CustomerRecord(response); failure = nil
        } catch where isCancellation(error) { }
        catch { failure = error.localizedDescription }
    }
}

private extension ISO8601DateFormatter {
    @MainActor static let dateOnly: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withFullDate]; formatter.timeZone = .current; return formatter
    }()
}

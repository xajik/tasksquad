import SwiftUI
import TaskSquadPortal

struct MobileScheduleFields: View {
    @Binding var values: [String: JSONValue]
    private var frequency: String { values["frequency"]?.string ?? "daily" }
    private var zone: TimeZone { TimeZone(identifier: values["timezone"]?.string ?? "") ?? .current }
    private var calendar: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = zone; return c }
    var body: some View {
        Section("Schedule") {
            if frequency == "hourly" {
                Picker("Minute of each hour", selection: number("minute", fallback: 0)) {
                    ForEach(0..<60, id: \.self) { Text(String(format: ":%02d", $0)).tag($0) }
                }
            } else {
                DatePicker("Time", selection: Binding(get: {
                    calendar.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: Int(values["hour"]?.number ?? 9), minute: Int(values["minute"]?.number ?? 0))) ?? Date()
                }, set: { date in
                    values["hour"] = .number(Double(calendar.component(.hour, from: date)))
                    values["minute"] = .number(Double(calendar.component(.minute, from: date)))
                }), displayedComponents: .hourAndMinute).environment(\.timeZone, zone)
            }
            if frequency == "weekly" {
                Picker("Weekday", selection: number("day_of_week", fallback: 1)) {
                    ForEach(0..<7, id: \.self) { Text(calendar.weekdaySymbols[$0]).tag($0) }
                }.accessibilityIdentifier("schedule-weekday")
            }
            if frequency == "monthly" {
                Picker("Day of month", selection: number("day_of_month", fallback: 1)) {
                    ForEach(1...31, id: \.self) { Text(String($0)).tag($0) }
                }.accessibilityIdentifier("schedule-monthday")
            }
            NavigationLink {
                MobileTimeZonePicker(selection: Binding(get: { values["timezone"]?.string ?? zone.identifier }, set: { values["timezone"] = .string($0) }))
            } label: { LabeledContent("Time zone", value: zone.identifier.replacingOccurrences(of: "_", with: " ")) }
        }
    }
    private func number(_ key: String, fallback: Int) -> Binding<Int> {
        Binding(get: { Int(values[key]?.number ?? Double(fallback)) }, set: { values[key] = .number(Double($0)) })
    }
}

private struct MobileTimeZonePicker: View {
    @Binding var selection: String
    @State private var search = ""
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List(TimeZone.knownTimeZoneIdentifiers.filter { search.isEmpty || $0.replacingOccurrences(of: "_", with: " ").localizedCaseInsensitiveContains(search) }, id: \.self) { zone in
            Button { selection = zone; dismiss() } label: {
                HStack { Text(zone.replacingOccurrences(of: "_", with: " ")); Spacer(); if selection == zone { MobileIcon(name: "check") } }.frame(minHeight: 44)
            }
        }.navigationTitle("Time zone").searchable(text: $search, prompt: "Search cities or time zones")
    }
}

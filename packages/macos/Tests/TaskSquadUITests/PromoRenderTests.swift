import AppKit
import SwiftUI
import XCTest
@testable import TaskSquad
@testable import TaskSquadCore
import TaskSquadPortal

/// Serves the launch sample workspace (`launch/media/native/sample-workspace.json`) as Worker responses.
private actor SampleTransport: HTTPTransport {
    let root: [String: Any]
    init(_ data: Data) { root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
    private func json(_ value: Any) -> HTTPResult { .init(data: try! JSONSerialization.data(withJSONObject: value), status: 200) }
    private func rows(_ key: String) -> [[String: Any]] { root[key] as? [[String: Any]] ?? [] }
    private func resource(_ key: String) -> [[String: Any]] { (root["resources"] as? [String: Any])?[key] as? [[String: Any]] ?? [] }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        let path = request.url!.path.split(separator: "/").map(String.init)
        if request.httpMethod != "GET" { return json(["ok": true]) }
        switch path.first {
        case "me": return json(root["me"]!)
        case "tasks":
            if path.count == 1 { return json(["tasks": rows("tasks")]) }
            if path.count == 2 { return json(rows("tasks").first { $0["id"] as? String == path[1] } ?? [:]) }
            if path[2] == "messages" { return json(["messages": (root["messages"] as? [String: Any])?[path[1]] ?? []]) }
            return json([path[2]: []])
        case "portals":
            if path.count == 1 { return json(["portals": rows("portals")]) }
            return json(rows("portals").first { $0["id"] as? String == path[1] } ?? [:])
        case "teams":
            if path.count == 1 { return json(["teams": rows("teams")]) }
            if path.count == 2 { return json(rows("teams")[0]) }
            let kind = path[2] == "sub-agents" ? "sub_agents" : path[2]
            switch kind {
            case "agents": return json(["agents": rows("agents")])
            case "stats": return json(root["stats"]!)
            default:
                let items = resource(kind)
                if path.count == 3 { return json([kind: items, "has_more": false]) }
                if path.count == 4 { return json(items.first { $0["id"] as? String == path[3] } ?? [:]) }
                if path[4] == "comments" { return json(["comments": (root["comments"] as? [String: Any])?[path[3]] ?? []]) }
                return json([path[4]: []])
            }
        default: return json([:])
        }
    }
}

/// Renders launch screenshots of the real macOS windows from the sample workspace.
/// Runs only from `launch/media/native/capture.sh`, which sets `TSQ_UI_ARTIFACTS` and either `TSQ_PROMO_API` or `TSQ_PROMO_SEED`.
@MainActor final class PromoRenderTests: PlatformTestCase {
    func testRenderLaunchScreens() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let directory = env["TSQ_UI_ARTIFACTS"], env["TSQ_PROMO_API"] != nil || env["TSQ_PROMO_SEED"] != nil else {
            throw XCTSkip("Set TSQ_PROMO_API (read-only proxy) or TSQ_PROMO_SEED (sample file) to render launch screens")
        }
        _ = NSApplication.shared
        let api: CustomerAPI
        if let proxy = env["TSQ_PROMO_API"].flatMap(URL.init(string:)) {
            api = CustomerAPI(baseURL: proxy) { _ in "fixture-token" }
        } else {
            let data = try Data(contentsOf: URL(fileURLWithPath: env["TSQ_PROMO_SEED"]!))
            api = CustomerAPI(baseURL: URL(string: "https://sample.invalid")!, transport: SampleTransport(data)) { _ in "sample-token" }
        }
        let model = CustomerWorkspaceModel(defaults: UserDefaults(suiteName: "ai.tasksquad.promo." + UUID().uuidString)!, api: api)
        await model.restore()
        let project = env["PROMO_PROJECT"] ?? "orbit-web"
        model.teamID = try XCTUnwrap(model.teams.first { $0.title == project }, "No project named \(project)").id
        let control = ControlPanelModel(paths: TaskSquadPaths(home: FileManager.default.temporaryDirectory.appendingPathComponent("tsq-promo")), loadSavedAccount: false)

        // (file name, section, title to select; "" selects the first record, nil selects nothing)
        let screens: [(String, CustomerSection, String?)] = [
            ("inbox", .inbox, "rate limiting"), ("waiting", .inbox, "release notes"), ("notes", .notes, "heatmap"),
            ("planner", .planners, "heatmap"), ("conveyor", .conveyors, ""), ("supervisor", .supervisor, ""),
            ("analytics", .analytics, nil), ("memory", .memory, ""), ("agents", .agents, ""), ("portals", .portals, ""),
        ]
        for (name, section, match) in screens {
            model.section = section; model.selectedID = nil
            await model.refresh()
            if let match {
                model.selectedID = (model.records.first { !match.isEmpty && $0.title.localizedCaseInsensitiveContains(match) } ?? model.records.first)?.id
                await model.refresh()
            }
            XCTAssertNil(model.error, name)
            for (suffix, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
                try await render(MainWindow(control: control, customer: model, initialSection: section), to: directory, name: "mac-\(name)-\(suffix)", appearance: appearance)
            }
        }
    }

    private func render<V: View>(_ value: V, to directory: String, name: String, appearance: NSAppearance.Name) async throws {
        let size = NSRect(x: 0, y: 0, width: 1280, height: 800)
        let view = NSHostingView(rootView: value.background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: size, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view; defer { window.contentView = nil }
        view.appearance = NSAppearance(named: appearance)
        view.frame = size
        for _ in 0..<8 { view.layoutSubtreeIfNeeded(); try await Task.sleep(for: .milliseconds(150)) }
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
    }
}

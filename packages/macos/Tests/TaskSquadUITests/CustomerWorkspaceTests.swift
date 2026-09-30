import AppKit
import SwiftUI
import XCTest
@testable import TaskSquad
@testable import TaskSquadCore

private actor WorkspaceTransport: HTTPTransport {
    var requests: [URLRequest] = []
    var holdTasks = false
    var pending: CheckedContinuation<HTTPResult, Never>?
    let record = ###"{"id":"item-1","name":"Builder","title":"Architecture review","subject":"Review the native workspace","status":"waiting_input","role":"owner","agent_id":"agent-1","sender_id":"user-1","body":"## Ready for review\n\nThe native workspace shares the cloud backend.\n\n- [x] Task inbox\n- [x] Team switching\n- [ ] Release verification","content":"# Shared project knowledge\n\nKeep the customer UI independent from the local engine.","description":"Coordinate the next release","created_at":1800000000000,"tags":["native","release"],"phases":[{"phase_id":"phase-1","name":"Implementation","status":"completed","retry_count":0,"max_retries":3,"last_response":"Ready for review"}],"attachments":[],"auto_install":1,"category":"architecture"}"###
    func suspendTasks() { holdTasks = true }
    func releaseTasks() { pending?.resume(returning: response("{\"tasks\":[\(record)]}")); pending = nil; holdTasks = false }
    func isWaiting() -> Bool { pending != nil }
    private func response(_ text: String) -> HTTPResult { .init(data: Data(text.utf8), status: 200) }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        requests.append(request)
        let path = request.url!.path
        if request.httpMethod != "GET" { return response(#"{"ok":true,"id":"created"}"#) }
        if path == "/me" { return response(#"{"id":"user-1","email":"fixture@example.invalid","plan":"pro"}"#) }
        if path == "/teams" { return response(#"{"teams":[{"id":"team-1","name":"Product","role":"owner","memory_enabled":true},{"id":"team-2","name":"Research","role":"viewer"}]}"#) }
        if path == "/tasks", holdTasks { return await withCheckedContinuation { pending = $0 } }
        let last = path.split(separator: "/").last.map(String.init) ?? ""
        if last == "item-1" { return response(record) }
        if last == "agents" { return response(#"{"agents":[{"id":"agent-1","name":"Builder","status":"online"}]}"#) }
        let envelope = last == "sub-agents" ? "sub_agents" : last
        if last == "notes" {
            let offset = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "offset" })?.value ?? "0"
            if offset != "0" { return response(#"{"notes":[{"id":"note-page2","title":"Second page"}],"has_more":false}"#) }
            return response("{\"notes\":[\(record)],\"has_more\":true}")
        }
        return response("{\"\(envelope)\":[\(record)]}")
    }
}

@MainActor final class CustomerWorkspaceTests: XCTestCase {
    private func fixture(_ transport: WorkspaceTransport = .init()) -> CustomerWorkspaceModel {
        let defaults = UserDefaults(suiteName: "ai.tasksquad.customer-tests." + UUID().uuidString)!
        let api = CustomerAPI(baseURL: URL(string: "https://fixture.invalid")!, transport: transport) { _ in "fixture-token" }
        return CustomerWorkspaceModel(defaults: defaults, api: api)
    }

    func testCustomerCanLoadEverySectionWithoutDaemonConfiguration() async throws {
        let transport = WorkspaceTransport(), model = fixture(transport)
        await model.restore()
        XCTAssertEqual(model.profile?.text("email"), "fixture@example.invalid")
        XCTAssertEqual(model.teamID, "team-1")
        for section in CustomerSection.allCases {
            model.section = section
            await model.refresh()
            XCTAssertNil(model.error, section.rawValue)
            if section != .settings { XCTAssertFalse(model.records.isEmpty, section.rawValue) }
        }
        let requests = await transport.requests
        XCTAssertTrue(requests.allSatisfy { $0.value(forHTTPHeaderField: "X-TSQ-Agent") == nil })
        XCTAssertFalse(requests.contains { $0.url?.path.contains("heartbeat") == true })
        XCTAssertTrue(model.isOwner)
        model.teamID = "team-2"
        XCTAssertFalse(model.isMaintainer); XCTAssertTrue(model.records.isEmpty)
    }

    func testLateProjectResponseCannotPopulateNewProject() async throws {
        let transport = WorkspaceTransport(), model = fixture(transport)
        await model.restore(); await transport.suspendTasks()
        let refresh = Task { await model.refresh() }
        for _ in 0..<100 {
            if await transport.isWaiting() { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let waiting = await transport.isWaiting(); XCTAssertTrue(waiting)
        model.teamID = "team-2"
        await transport.releaseTasks(); await refresh.value
        XCTAssertTrue(model.records.isEmpty)
        XCTAssertNil(model.detail)
        await model.refresh()
        XCTAssertFalse(model.records.isEmpty)
    }

    func testNotesPaginationAndSelectedDetailsStayAvailable() async throws {
        let model = fixture()
        await model.restore(); model.section = .notes
        await model.refresh(); XCTAssertTrue(model.hasMore)
        await model.refresh(loadMore: true)
        XCTAssertEqual(model.records.count, 2); XCTAssertFalse(model.hasMore)
        await model.refresh()
        XCTAssertEqual(model.records.count, 2)
        model.section = .inbox; model.selectedID = "item-1"
        await model.refresh()
        XCTAssertEqual(model.detail?.id, "item-1")
        XCTAssertEqual(model.messages.count, 1)
    }

    func testRemoteTerminalFramesPreserveUnicodeAndResize() throws {
        let bytes = Data("café 猫\u{1b}[A\r".utf8)
        let frame = try JSONDecoder().decode(JSONValue.self, from: CustomerTerminalModel.inputFrame(bytes))
        XCTAssertEqual(frame["t"]?.string, "i")
        XCTAssertEqual(Data(base64Encoded: frame["d"]!.string!), bytes)
        let resize = try JSONDecoder().decode(JSONValue.self, from: CustomerTerminalModel.resizeFrame(cols: 132, rows: 40))
        XCTAssertEqual(resize["c"]?.number, 132); XCTAssertEqual(resize["r"]?.number, 40)
        let model = CustomerTerminalModel()
        model.disconnect(); XCTAssertFalse(model.connected)
    }

    func testNativeCustomerScreensRenderInLightAndDark() async throws {
        _ = NSApplication.shared
        let model = fixture(); await model.restore()
        for section in [CustomerSection.inbox, .notes, .planners, .skills, .memory, .settings] {
            model.section = section; model.selectedID = section == .settings ? nil : "item-1"
            await model.refresh()
            try render(CustomerWorkspace(model: model), name: "customer-" + section.resource, appearance: .aqua)
        }
        model.section = .inbox; model.selectedID = "item-1"; await model.refresh()
        try render(CustomerWorkspace(model: model), name: "customer-inbox-dark", appearance: .darkAqua)
        let request = CustomerEditorRequest(title: "New Task", fields: CustomerField.fields(for: .inbox), attachments: true) { _, _ in false }
        try render(CustomerEditor(model: model, request: request), name: "customer-compose", appearance: .aqua)
    }

    func testEveryLucideIconAndBrandImageLoadsAsTemplate() {
        _ = NSApplication.shared
        for icon in LucideIcon.allCases {
            XCTAssertTrue(icon.image.isValid, icon.rawValue)
            XCTAssertTrue(icon.image.representations.contains { $0.pixelsWide != 0 || $0.size.width > 0 }, icon.rawValue)
            XCTAssertTrue(icon.image.isTemplate, icon.rawValue)
        }
        XCTAssertEqual(LucideIcon.load("Brand/logo", template: false).size.width, 512)
        XCTAssertTrue(BrandImage.tray.isTemplate)
    }

    func testCancellationNeverSurfacesAsAnError() {
        XCTAssertTrue(isCancellation(CancellationError()))
        XCTAssertTrue(isCancellation(URLError(.cancelled)))
        XCTAssertFalse(isCancellation(URLError(.timedOut)))
    }

    func testMainWindowListsOnlyProjectSectionsAndCoversEveryWebPage() {
        let shown = Set(MainWindow.sections), library: Set<CustomerSection> = [.subAgents, .commands]
        XCTAssertEqual(shown.union(library), Set(CustomerSection.allCases))
        XCTAssertEqual(MainWindow.sections.first, .inbox)
    }

    func testMainWindowRendersSignedInAndSignedOut() async throws {
        _ = NSApplication.shared
        let control = ControlPanelModel(paths: TaskSquadPaths(home: FileManager.default.temporaryDirectory.appendingPathComponent("tsq-preview-fixture")), loadSavedAccount: false)
        control.configuration = try DaemonConfiguration.parse("""
        [[agents]]
        id = 'builder'
        name = 'Builder'
        command = 'claude'
        work_dir = '/tmp/tasksquad'
        """)
        control.selectedAgentID = "builder"
        let signedOut = CustomerWorkspaceModel(defaults: UserDefaults(suiteName: "ai.tasksquad.window-tests." + UUID().uuidString)!)
        try render(MainWindow(control: control, customer: signedOut, initialSection: .inbox), name: "window-signed-out", appearance: .aqua)
        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            try render(ThisMacWindow(control: control, initialSection: .agents), name: "this-mac-agents-" + name, appearance: appearance)
            try render(ThisMacWindow(control: control, initialSection: .tools), name: "this-mac-tools-" + name, appearance: appearance)
        }
        let model = fixture(); await model.restore()
        model.section = .inbox; model.selectedID = "item-1"; await model.refresh()
        try render(MainWindow(control: control, customer: model, initialSection: .inbox), name: "window-inbox-light", appearance: .aqua)
        try render(MainWindow(control: control, customer: model, initialSection: .inbox), name: "window-inbox-dark", appearance: .darkAqua)
        try render(SettingsView(), name: "settings-appearance", appearance: .aqua)
    }

    private func render<V: View>(_ value: V, name: String, appearance: NSAppearance.Name) throws {
        let view = NSHostingView(rootView: value.background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view; defer { window.contentView = nil }
        view.appearance = NSAppearance(named: appearance)
        view.frame = NSRect(x: 0, y: 0, width: 1200, height: 820)
        view.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.08))
        view.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        XCTAssertGreaterThan(png.count, 5000)
        if let directory = ProcessInfo.processInfo.environment["TSQ_UI_ARTIFACTS"] {
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
        }
    }
}

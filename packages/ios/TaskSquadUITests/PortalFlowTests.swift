import XCTest
import CryptoKit

/// Native journeys through production views, HTTP and WebSocket code.
/// The fixture is loopback and stateful, not an in-app demo or a live daemon.
@MainActor final class PortalFlowTests: XCTestCase {
    private let app = XCUIApplication()
    private let base = URL(string: "http://127.0.0.1:18743")!
    private func control(_ route: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: base.appendingPathComponent("__test/" + route))
        if let body { req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }
    private func launch(project: Bool = true) async throws {
        _ = try await control("reset")
        app.launchArguments = ["--ui-test-api", base.absoluteString, "--ui-test-reset-drafts", "--ui-test-appearance", "light"]
        app.launch()
        XCTAssertTrue(app.buttons["open-sidebar"].waitForExistence(timeout: 5) || app.buttons["nav-Inbox"].exists)
        if project { chooseProject("Test workspace") }
    }
    private func openSidebar() {
        let button = app.buttons["open-sidebar"]
        if button.exists { button.tap() }
    }
    private func navigate(_ identifier: String) {
        openSidebar()
        let item = app.buttons[identifier]
        let sidebar = app.scrollViews["sidebar-destinations"]
        if !app.buttons["close-sidebar"].exists {
            for _ in 0..<3 { sidebar.swipeDown() }
        }
        for _ in 0..<12 {
            if item.isHittable { break }
            sidebar.swipeUp()
        }
        XCTAssertTrue(item.waitForExistence(timeout: 5)); XCTAssertTrue(item.isHittable); item.tap()
    }
    private func chooseProject(_ name: String) {
        navigate("nav-projects")
        let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'project-' AND label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 5)); project.tap()
    }
    private func section(_ name: String) {
        let library = ["Skills", "Sub-agents", "Commands"].contains(name)
        navigate("nav-" + (library ? "Skills" : name))
        if library && name != "Skills" {
            app.buttons["library-selector"].tap(); app.buttons[name].tap()
        }
        let title = ["Settings": "Project Settings", "Conveyors": "Conveyor", "Planners": "Planner"][name] ?? name
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
    }
    private func create() { let button = app.buttons["create-item"]; XCTAssertTrue(button.waitForExistence(timeout: 5)); XCTAssertTrue(button.isHittable); button.tap() }
    private func agent() { app.buttons["field-agent_id"].tap(); app.buttons["Fixture Agent"].tap() }
    private func type(_ id: String, _ text: String) { let field = app.descendants(matching: .any)["field-"+id].firstMatch; XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText(text); if app.buttons["Done editing"].exists { app.buttons["Done editing"].tap() } }
    private func back() {
        let back = app.navigationBars.buttons.matching(identifier: "BackButton").firstMatch
        (back.exists ? back : app.navigationBars.buttons.element(boundBy: 0)).tap()
    }
    private func openTask() { let row = app.buttons["record-task"]; XCTAssertTrue(row.waitForExistence(timeout: 5)); row.tap(); XCTAssertTrue(app.buttons["reply-task"].waitForExistence(timeout: 5)) }
    private func openPortal() async throws -> String {
        section("Portals"); create(); agent(); app.buttons["editor-submit"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["live-terminal"].firstMatch.waitForExistence(timeout: 12))
        let state = try await control("state"), portals = state["portals"] as! [String: Any]
        return portals.keys.first!
    }
    private func filterStatus(_ value: String) {
        app.buttons["view-options"].tap()
        let status = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Status'")).firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 5)); status.tap()
        let option = app.buttons[value]; XCTAssertTrue(option.waitForExistence(timeout: 5)); option.tap()
    }
    private func scrollTo(_ element: XCUIElement) {
        for _ in 0..<6 { if element.exists && element.isHittable && app.frame.contains(element.frame) { break }; app.swipeUp() }
        XCTAssertTrue(element.exists); XCTAssertTrue(element.isHittable)
    }
    private func screenshot(_ name: String) { let a = XCTAttachment(screenshot: app.screenshot()); a.name = name; a.lifetime = .keepAlways; add(a) }
    private func assertImageRoundTrip(taskID: String, message: [String: Any]) async throws {
        let attachment = (message["attachments"] as! [[String: Any]])[0]
        let attachmentID = attachment["id"] as! String
        let messageID = message["id"] as! String
        let image = app.images["test.png"].firstMatch
        scrollTo(image)
        XCTAssertTrue(image.waitForExistence(timeout: 8), "Authenticated download renders the uploaded image")
        var request = URLRequest(url: base.appendingPathComponent("tasks/\(taskID)/messages/\(messageID)/attachments/\(attachmentID)"))
        request.setValue("Bearer fixture-token", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertGreaterThan(data.count, 100)
        XCTAssertEqual(data.count, attachment["size"] as? Int)
        XCTAssertEqual(data.prefix(8), Data([137,80,78,71,13,10,26,10]))
        XCTAssertEqual(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), attachment["sha256"] as? String)
    }
    private func assertFits(_ element: XCUIElement) { XCTAssertTrue(element.isHittable); XCTAssertTrue(app.frame.contains(element.frame), "Control outside screen: \(element.frame), screen \(app.frame)") }

    func test01EmptyProjectKeepsNavigationAndNativeLayout() async throws {
        try await launch(project: false)
        XCTAssertTrue(app.staticTexts["No inbox"].waitForExistence(timeout: 5))
        assertFits(app.buttons["open-sidebar"])
        assertFits(app.buttons["view-options"]); assertFits(app.buttons["create-item"])
        screenshot("01-empty-project")
        chooseProject("Test workspace"); XCTAssertTrue(app.buttons["record-task"].waitForExistence(timeout: 5))
        screenshot("02-inbox")
    }
    func test02ProjectSwitchClearsOldRecords() async throws {
        try await launch(); XCTAssertTrue(app.buttons["record-task"].waitForExistence(timeout: 5))
        chooseProject("Empty project"); XCTAssertTrue(app.staticTexts["No inbox"].waitForExistence(timeout: 5)); XCTAssertFalse(app.buttons["record-task"].exists)
        chooseProject("Test workspace"); XCTAssertTrue(app.buttons["record-task"].waitForExistence(timeout: 5))
    }
    func test03InboxStatusFilter() async throws {
        try await launch(); filterStatus("Done")
        XCTAssertTrue(app.staticTexts["No inbox"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["view-options"].label, "View options, filtered")
        filterStatus("Waiting Input")
        XCTAssertTrue(app.buttons["record-task"].waitForExistence(timeout: 5))
    }
    func test04CreateUnicodeTaskAndInitialImage() async throws {
        try await launch(); create(); type("subject", "Unicode 猫 café"); agent(); type("body", "Review 🚀")
        scrollTo(app.buttons["Attach test image"]); app.buttons["Attach test image"].tap(); app.buttons["editor-submit"].tap()
        XCTAssertTrue(app.buttons["reply-task"].waitForExistence(timeout: 8))
        let state = try await control("state"), tasks = state["tasks"] as! [String:[String:Any]]
        XCTAssertEqual(tasks.count,2); XCTAssertTrue(tasks.values.contains { $0["subject"] as? String == "Unicode 猫 café" })
        let messages = state["messages"] as! [String:[[String:Any]]]
        XCTAssertTrue(messages.values.contains { ($0.first?["attachments"] as? [Any])?.count == 1 })
        let createdID = tasks.first { $0.value["subject"] as? String == "Unicode 猫 café" }!.key
        try await assertImageRoundTrip(taskID: createdID, message: messages[createdID]![0])
        screenshot("03-created-task")
    }
    func test05ReplyAndImageRoundTrip() async throws {
        try await launch(); openTask(); screenshot("04-conversation")
        app.buttons["reply-task"].tap(); type("body", "Reply café 猫")
        app.buttons["Attach test image"].tap(); app.buttons["editor-submit"].tap()
        XCTAssertTrue(app.staticTexts["Reply café 猫"].waitForExistence(timeout: 8))
        let state = try await control("state"), messages = state["messages"] as! [String:[[String:Any]]]
        XCTAssertEqual(messages["task"]!.count,2); XCTAssertEqual((messages["task"]!.last!["attachments"] as! [Any]).count,1)
        try await assertImageRoundTrip(taskID: "task", message: messages["task"]!.last!)
        screenshot("13-reply-image")
    }
    func test06CreateErrorRetainsDraft() async throws {
        try await launch(); _ = try await control("fail", body:["method":"POST","path":"/tasks","error":"Creation rejected"])
        create(); type("subject","Retry this task"); agent(); app.buttons["editor-submit"].tap()
        XCTAssertTrue(app.staticTexts["editor-error"].waitForExistence(timeout: 5)); XCTAssertEqual(app.textFields["field-subject"].value as? String,"Retry this task")
        app.buttons["editor-submit"].tap(); XCTAssertTrue(app.buttons["reply-task"].waitForExistence(timeout: 8))
    }
    func test07PendingPortalStartsRealTerminal() async throws {
        try await launch(); _ = try await openPortal()
        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 8)); assertFits(app.buttons["close-portal"])
        let terminal = app.descendants(matching: .any)["live-terminal"].firstMatch
        XCTAssertTrue((terminal.value as? String)?.contains("Fixture shell ready") == true, "Actual socket output reaches SwiftTerm")
        XCTAssertGreaterThan(terminal.frame.height, 200)
        screenshot("05-live-terminal")
        let state = try await control("state"), portals = state["portals"] as! [String:[String:Any]]
        XCTAssertEqual(portals.values.first!["status"] as? String,"running")
    }
    func test08TerminalControlInputAndResize() async throws {
        try await launch(); _ = try await openPortal(); XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 8))
        let terminal = app.descendants(matching: .any)["live-terminal"].firstMatch
        app.textFields["terminal-input"].tap(); app.textFields["terminal-input"].typeText("echo café"); app.buttons["send-terminal-input"].tap()
        app.buttons["Tab"].tap(); app.buttons["Ctrl-C"].tap()
        if app.buttons["Hide keyboard"].exists { app.buttons["Hide keyboard"].tap() }
        XCUIDevice.shared.orientation = .landscapeLeft
        let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            self.app.frame.width > self.app.frame.height && self.app.buttons["close-portal"].isHittable && self.app.frame.contains(self.app.buttons["close-portal"].frame)
        }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 8), .completed)
        assertFits(app.buttons["close-portal"])
        XCTAssertGreaterThan(terminal.frame.height, 100)
        let rotated = XCUIScreen.main.screenshot()
        XCTAssertGreaterThan(rotated.image.size.width, rotated.image.size.height)
        let attachment = XCTAttachment(screenshot: rotated); attachment.name = "06-terminal-landscape"; attachment.lifetime = .keepAlways; add(attachment)
        XCUIDevice.shared.orientation = .portrait
        let (data,_) = try await URLSession.shared.data(from:base.appendingPathComponent("__test/events"))
        let events = String(decoding:data,as:UTF8.self)
        let inputs = events.split(separator: "\n").compactMap { line -> String? in
            guard let value = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], value["kind"] as? String == "input" else { return nil }
            return value["text"] as? String
        }.joined()
        XCTAssertTrue(inputs.contains("echo café")); XCTAssertTrue(events.contains("\"kind\": \"input\"")); XCTAssertTrue(events.contains("\"kind\": \"resize\""))
    }
    func test09ReconnectMakesNewSocket() async throws {
        try await launch(); _ = try await openPortal(); XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 8))
        app.buttons["Reconnect terminal"].tap(); XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 8))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(app.buttons["close-portal"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 8))
        let (data,_) = try await URLSession.shared.data(from:base.appendingPathComponent("__test/events"))
        XCTAssertGreaterThanOrEqual(String(decoding:data,as:UTF8.self).components(separatedBy:"\"kind\": \"socket_open\"").count-1,2)
    }
    func test10CancelClosePreservesRunningSession() async throws {
        try await launch(); let id = try await openPortal(); app.buttons["close-portal"].tap()
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5)); app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["close-portal"].isHittable)
        let state = try await control("state"), portals = state["portals"] as! [String:[String:Any]]; XCTAssertEqual(portals[id]!["status"] as? String,"running")
    }
    func test11CloseErrorKeepsDetailOpen() async throws {
        try await launch(); let id = try await openPortal()
        _ = try await control("fail",body:["method":"POST","path":"/portals/\(id)/close","error":"Close rejected"])
        app.buttons["close-portal"].tap(); app.buttons["Close Portal"].tap()
        XCTAssertTrue(app.staticTexts["detail-error"].waitForExistence(timeout: 5)); XCTAssertTrue(app.buttons["close-portal"].isHittable)
    }
    func test12CloseRetainsCompletedHistory() async throws {
        try await launch(); let id = try await openPortal(); app.buttons["close-portal"].tap(); app.buttons["Close Portal"].tap()
        XCTAssertTrue(app.staticTexts["Portal completed"].waitForExistence(timeout: 8)); XCTAssertFalse(app.descendants(matching: .any)["live-terminal"].firstMatch.exists)
        back(); XCTAssertTrue(app.staticTexts["History"].waitForExistence(timeout: 5)); XCTAssertTrue(app.buttons["record-"+id].exists)
        screenshot("07-portal-history")
    }
    func test13NotesCreateEditAndComment() async throws {
        try await launch(); section("Notes"); create(); type("title","Test note"); type("content","Note content"); app.buttons["editor-submit"].tap()
        XCTAssertTrue(app.buttons["add-comment"].waitForExistence(timeout: 5)); app.buttons["add-comment"].tap(); type("content","Review comment"); app.buttons["editor-submit"].tap()
        XCTAssertTrue(app.staticTexts["Review comment"].waitForExistence(timeout: 5)); screenshot("08-note")
    }
    func test14AllWorkspaceSectionsLoad() async throws {
        try await launch()
        for name in ["Agents","Members","Skills","Sub-agents","Commands","Memory","Analytics","Conveyors","Planners","Supervisor","Settings"] { section(name); XCTAssertFalse(app.staticTexts["workspace-error"].exists) }
        screenshot("09-settings")
    }
    func test17DarkAppearanceAndLargeTextRemainUsable() async throws {
        _ = try await control("reset")
        app.launchArguments = ["--ui-test-api", base.absoluteString, "--ui-test-reset-drafts", "--ui-test-appearance", "dark", "--ui-test-large-text"]
        app.launch()
        XCTAssertTrue(app.buttons["open-sidebar"].waitForExistence(timeout: 10)); assertFits(app.buttons["open-sidebar"])
        chooseProject("Test workspace")
        screenshot("11-dark-large-inbox")
        scrollTo(app.buttons["record-task"]); app.buttons["record-task"].tap()
        scrollTo(app.buttons["reply-task"]); assertFits(app.buttons["reply-task"])
        screenshot("12-dark-large-conversation")
    }
    func test16BrowserPKCEKeychainAndLogout() async throws {
        _ = try await control("reset")
        app.launchArguments = ["--ui-test-auth", base.absoluteString, "--ui-test-reset-auth", "--ui-test-reset-drafts"]
        app.launch()
        XCTAssertTrue(app.buttons["Continue to sign in"].waitForExistence(timeout: 10)); screenshot("00-sign-in"); app.buttons["Continue to sign in"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if app.buttons["Continue"].waitForExistence(timeout: 3) { app.buttons["Continue"].tap() }
        else if springboard.buttons["Continue"].exists { springboard.buttons["Continue"].tap() }
        let link = app.webViews.links["Authorize fixture"]
        XCTAssertTrue(link.waitForExistence(timeout: 12)); link.tap()
        XCTAssertTrue(app.buttons["open-sidebar"].waitForExistence(timeout: 10))
        screenshot("10-authenticated-workspace")
        let (data,_) = try await URLSession.shared.data(from: base.appendingPathComponent("__test/events"))
        XCTAssertTrue(String(decoding:data,as:UTF8.self).contains("\"verified\": true"))
        navigate("nav-account"); app.buttons["Sign out"].tap()
        XCTAssertTrue(app.buttons["Continue to sign in"].waitForExistence(timeout: 10))
        app.terminate(); app.launchArguments = ["--ui-test-auth", base.absoluteString]; app.launch()
        XCTAssertTrue(app.buttons["Continue to sign in"].waitForExistence(timeout: 10), "Logout purges the persisted credential")
    }
    func test15SeededNavigationAndForegroundRecovery() async throws {
        try await launch(); var seed: UInt64 = 0x51C0FFEE
        let names = ["Inbox","Notes","Agents","Portals","Analytics","Skills"]
        for _ in 0..<15 { seed = seed &* 6364136223846793005 &+ 1442695040888963407; section(names[Int((seed>>32)%UInt64(names.count))]); assertFits(app.buttons["open-sidebar"]) }
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(app.buttons["open-sidebar"].waitForExistence(timeout: 5))
    }
    func test18SidebarDismissalAndUtilityBackPreserveDetail() async throws {
        try await launch()
        openSidebar()
        XCTAssertFalse(app.buttons["create-item"].isHittable)
        app.buttons["close-sidebar"].tap()
        XCTAssertTrue(app.buttons["create-item"].isHittable)
        navigate("nav-account")
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.switches["Project memory"].exists)
        back()
        XCTAssertTrue(app.buttons["create-item"].waitForExistence(timeout: 5))
        // Pushed screens show Back only; the drawer button belongs to root screens.
        openTask()
        XCTAssertFalse(app.buttons["open-sidebar"].exists)
        XCTAssertTrue(app.buttons["more-actions"].isHittable)
        app.buttons["more-actions"].tap()
        XCTAssertTrue(app.buttons["Forward to agent"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Delete task"].exists)
        app.buttons["Forward to agent"].tap(); app.buttons["Cancel"].tap()
        back()
        chooseProject("Empty project")
        XCTAssertTrue(app.staticTexts["No inbox"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["reply-task"].exists)
    }
    func test19NavigationScreenshots() async throws {
        try await launch()
        for appearance in ["light", "dark"] {
            app.terminate()
            app.launchArguments = ["--ui-test-api", base.absoluteString, "--ui-test-appearance", appearance]
            app.launch()
            XCTAssertTrue(app.buttons["open-sidebar"].waitForExistence(timeout: 10) || app.buttons["nav-Inbox"].exists)
            chooseProject("Test workspace")
            screenshot("navigation-inbox-" + appearance)
            openSidebar(); screenshot("navigation-sidebar-" + appearance)
            if app.buttons["close-sidebar"].exists { app.buttons["close-sidebar"].tap() }
            navigate("nav-projects"); screenshot("navigation-projects-" + appearance); back()
            navigate("nav-account"); screenshot("navigation-account-" + appearance); back()
        }
    }

    func test20ProjectsSearchAndRetry() async throws {
        try await launch()
        _ = try await control("fail", body: ["method": "GET", "path": "/teams", "status": 503, "error": "Projects unavailable"])
        navigate("nav-projects")
        XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 5)); app.buttons["Retry"].tap()
        XCTAssertTrue(app.buttons["project-demo"].waitForExistence(timeout: 5))
        let search = app.searchFields.firstMatch
        search.tap(); search.typeText("Test workspace")
        XCTAssertFalse(app.buttons["project-empty"].exists)
        app.buttons["project-demo"].tap()
        XCTAssertTrue(app.buttons["record-task"].waitForExistence(timeout: 5))
    }
    func test21NoProjectsStillAllowsAccountAndProjectRefresh() async throws {
        _ = try await control("reset")
        _ = try await control("projects", body: ["projects": []])
        app.launchArguments = ["--ui-test-api", base.absoluteString]
        app.launch()
        XCTAssertTrue(app.staticTexts["No projects"].waitForExistence(timeout: 10))
        navigate("nav-account")
        XCTAssertTrue(app.buttons["Sign out"].waitForExistence(timeout: 5)); back()
        navigate("nav-projects")
        XCTAssertTrue(app.staticTexts["No projects"].waitForExistence(timeout: 5))
    }
    func test22ProjectSettingsRespectMemberRole() async throws {
        _ = try await control("reset")
        _ = try await control("projects", body: ["projects": [["id": "demo", "name": "A project with a very long name for a small screen", "role": "member"]]])
        app.launchArguments = ["--ui-test-api", base.absoluteString]
        app.launch()
        XCTAssertTrue(app.buttons["record-task"].waitForExistence(timeout: 10))
        section("Settings")
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Your role' OR (label == 'Member')")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.switches["Project memory"].exists)
        XCTAssertFalse(app.buttons["Sign out"].exists)
    }
    func test23EdgeSwipeOpensAndSwipeClosesSidebar() async throws {
        try await launch()
        guard app.buttons["open-sidebar"].exists else { throw XCTSkip("Regular width keeps a persistent sidebar") }
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)))
        XCTAssertTrue(app.buttons["close-sidebar"].waitForExistence(timeout: 3))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)))
        XCTAssertTrue(app.buttons["close-sidebar"].waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.buttons["record-task"].isHittable)
    }

    /// Baseline usability evidence: required inputs are discovered on submit,
    /// and a task can be created with a subject and agent but no message.
    func test24TaskRequirementsAndEditorLayout() async throws {
        try await launch(); create()
        screenshot("24-task-editor")
        app.buttons["editor-submit"].tap()
        XCTAssertTrue(app.staticTexts["editor-error"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["editor-error"].label.contains("Subject is required"))
        XCTAssertLessThan(app.staticTexts["editor-error"].frame.height, 100, "Validation must not consume the editor")
        screenshot("25-task-required-subject")
        type("subject", "Usability audit task")
        XCTAssertFalse(app.staticTexts["editor-error"].exists, "Correcting a field clears its error")
        app.buttons["editor-submit"].tap()
        XCTAssertTrue(app.staticTexts["editor-error"].label.contains("Agent is required"))
        agent()
        XCTAssertFalse(app.staticTexts["editor-error"].exists, "Selecting an agent clears its error")
        scrollTo(app.switches["Save tokens"])
        screenshot("26-task-options")
        let before = try await control("state")
        XCTAssertEqual((before["tasks"] as? [String: Any])?.count, 1, "Invalid submissions do not create tasks")
        app.buttons["editor-submit"].tap()
        XCTAssertTrue(app.buttons["reply-task"].waitForExistence(timeout: 8))
        let after = try await control("state")
        XCTAssertEqual((after["tasks"] as? [String: Any])?.count, 2)
    }

    func test25ReplyCancellationRestoresTextDraft() async throws {
        try await launch(); openTask(); app.buttons["reply-task"].tap()
        screenshot("27-reply-editor")
        type("body", "Keep this reply draft")
        app.buttons["Attach test image"].tap()
        XCTAssertTrue(app.staticTexts["test.png"].exists)
        app.buttons["Cancel"].tap()
        app.buttons["reply-task"].tap()
        let body = app.textViews["field-body"]
        XCTAssertTrue(body.waitForExistence(timeout: 5))
        XCTAssertEqual(body.value as? String, "Keep this reply draft")
        XCTAssertTrue(app.staticTexts["test.png"].exists, "Selected images are restored with the text")
        app.buttons["Cancel"].tap()
        app.terminate()
        app.launchArguments = ["--ui-test-api", base.absoluteString, "--ui-test-appearance", "light"]
        app.launch()
        chooseProject("Test workspace"); openTask(); app.buttons["reply-task"].tap()
        XCTAssertEqual(app.textViews["field-body"].value as? String, "Keep this reply draft")
        XCTAssertTrue(app.staticTexts["test.png"].exists, "Images survive a process relaunch")
        body.tap()
        screenshot("28-reply-keyboard")
        let state = try await control("state")
        let messages = state["messages"] as? [String: [[String: Any]]]
        XCTAssertEqual(messages?["task"]?.count, 1, "Cancelling does not send a reply")
    }

    func test26NoteEditingActionLayout() async throws {
        try await launch(); section("Notes"); create()
        screenshot("29-note-editor")
        type("title", "Usability audit note"); type("content", "Content comes first.")
        app.buttons["editor-submit"].tap()
        XCTAssertTrue(app.buttons["add-comment"].waitForExistence(timeout: 5))
        screenshot("30-note-detail")
        assertFits(app.buttons["edit-record"])
        app.buttons["edit-record"].tap()
        screenshot("31-note-edit")
        XCTAssertEqual(app.textFields["field-title"].value as? String, "Usability audit note")
        XCTAssertEqual(app.textViews["field-content"].value as? String, "Content comes first.")
    }

    func test27ProjectNameSwitchesWorkspaceDirectly() async throws {
        try await launch()
        assertFits(app.buttons["switch-project"])
        app.buttons["switch-project"].tap()
        app.buttons["project-empty"].tap()
        XCTAssertTrue(app.staticTexts["No inbox"].waitForExistence(timeout: 5))
        app.buttons["switch-project"].tap()
        app.buttons["project-demo"].tap()
        XCTAssertTrue(app.buttons["record-task"].waitForExistence(timeout: 5))
        screenshot("32-project-switcher")
    }

}

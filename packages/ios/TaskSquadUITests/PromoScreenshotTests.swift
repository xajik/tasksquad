import XCTest

/// Captures launch screenshots of a real project through `launch/media/native/readonly_proxy.py`.
/// Skipped unless `PROMO_API` is set (xcodebuild passes `TEST_RUNNER_PROMO_API`); see `launch/media/native/capture.sh`.
/// Only navigates and reads: the proxy rejects every write.
@MainActor final class PromoScreenshotTests: XCTestCase {
    private let app = XCUIApplication()
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    func testCaptureLaunchScreens() throws {
        guard let api = env["PROMO_API"] else { throw XCTSkip("Set TEST_RUNNER_PROMO_API to capture launch screens") }
        let project = env["PROMO_PROJECT"] ?? "orbit-web"
        for appearance in ["light", "dark"] {
            app.launchArguments = ["--ui-test-api", api, "--ui-test-appearance", appearance]
            app.launch()
            XCTAssertTrue(app.buttons["open-sidebar"].waitForExistence(timeout: 15))
            navigate("nav-projects")
            let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'project-' AND label CONTAINS %@", project)).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
            settle(); shot("ios-inbox-\(appearance)")
            if open(matching: env["PROMO_TASK"] ?? "rate limiting") { shot("ios-task-\(appearance)"); back() }
            for (section, match, name) in [("Notes", "heatmap", "notes"), ("Planners", "heatmap", "planner"), ("Conveyors", "", "conveyor"),
                                           ("Portals", "", "portals"), ("Analytics", "", "analytics")] {
                go(section); settle(); shot("ios-\(name)-\(appearance)")
                if !match.isEmpty, open(matching: match) { shot("ios-\(name)-detail-\(appearance)"); back() }
            }
            app.terminate()
        }
    }

    private func navigate(_ identifier: String) {
        if app.buttons["open-sidebar"].exists { app.buttons["open-sidebar"].tap() }
        let item = app.buttons[identifier]
        for _ in 0..<12 where !item.isHittable { app.scrollViews["sidebar-destinations"].swipeUp() }
        XCTAssertTrue(item.waitForExistence(timeout: 5)); item.tap()
    }
    private func go(_ section: String) {
        navigate("nav-" + section)
        let title = ["Planners": "Planner", "Conveyors": "Conveyor"][section] ?? section
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 5))
    }
    /// Opens the first record whose label contains `text`, or the first record when none matches.
    private func open(matching text: String) -> Bool {
        let records = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'record-'"))
        guard records.firstMatch.waitForExistence(timeout: 8) else { return false }
        // Rows below the fold aren't in the hierarchy until scrolled into view.
        let match = records.matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
        for _ in 0..<5 where !(match.exists && match.isHittable) { app.swipeUp() }
        (match.exists ? match : records.firstMatch).tap()
        settle(2.5); return true
    }
    private func back() { app.navigationBars.buttons.element(boundBy: 0).tap(); settle(1) }
    private func settle(_ seconds: TimeInterval = 2) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}

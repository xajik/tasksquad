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
            XCTAssertTrue(app.buttons["project-picker"].waitForExistence(timeout: 15))
            app.buttons["project-picker"].tap(); app.buttons[project].tap()
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

    private func go(_ section: String) {
        let picker = app.buttons["section-picker"]
        if !picker.isHittable { app.swipeDown() }
        XCTAssertTrue(picker.waitForExistence(timeout: 5)); picker.tap(); app.buttons[section].tap()
    }
    /// Opens the first record whose label contains `text`, or the first record when none matches.
    private func open(matching text: String) -> Bool {
        let records = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'record-'"))
        guard records.firstMatch.waitForExistence(timeout: 8) else { return false }
        let match = records.matching(NSPredicate(format: "label CONTAINS[c] %@", text)).firstMatch
        (match.exists ? match : records.firstMatch).tap()
        settle(2.5); return true
    }
    private func back() { app.navigationBars.buttons.element(boundBy: 0).tap(); settle(1) }
    private func settle(_ seconds: TimeInterval = 2) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}

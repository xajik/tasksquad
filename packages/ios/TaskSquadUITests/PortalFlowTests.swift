import XCTest

final class PortalFlowTests: XCTestCase {
    func testOpenMonitorAndClosePortal() {
        let app = XCUIApplication()
        app.launchArguments.append("--ui-test-demo")
        app.launch()

        XCTAssertTrue(app.navigationBars["Portals"].waitForExistence(timeout: 10))
        let portal = app.buttons["portal-row-demo-portal"]
        XCTAssertTrue(portal.waitForExistence(timeout: 5))
        attach(app, name: "Portal Home")
        portal.tap()

        XCTAssertTrue(app.staticTexts["Connected · Demo"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.otherElements["demo-terminal"].exists || app.staticTexts["Portal terminal is ready."].exists)
        attach(app, name: "Portal Terminal")
        app.buttons["close-portal"].tap()
        app.buttons["Close Portal"].tap()

        XCTAssertTrue(app.staticTexts["No Portals open"].waitForExistence(timeout: 5))
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

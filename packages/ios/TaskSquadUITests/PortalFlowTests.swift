import XCTest

private struct PortalMonkeyIteration: Encodable {
    let iteration: Int
    let launchToListMilliseconds: Double
    let openTerminalMilliseconds: Double
    let closeMilliseconds: Double
    let actionTrace: [String]
}

@MainActor final class PortalFlowTests: XCTestCase {
    func testPortalMonkeyRunner15Iterations() throws {
        var randomState: UInt64 = 0x51C0_FFEE
        func next(_ upperBound: UInt64) -> UInt64 {
            randomState = randomState &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return (randomState >> 32) % upperBound
        }

        var metrics: [PortalMonkeyIteration] = []
        for iteration in 1...15 {
            let app = XCUIApplication()
            app.launchArguments = ["--ui-test-demo", "--monkey-iteration=\(iteration)"]
            let launchStart = Date()
            app.launch()
            XCTAssertTrue(app.navigationBars["Portals"].waitForExistence(timeout: 10), "iteration \(iteration): app reaches Portal list")
            let launchTime = Date().timeIntervalSince(launchStart) * 1_000
            let portal = app.buttons["portal-row-demo-portal"]
            XCTAssertTrue(portal.waitForExistence(timeout: 5), "iteration \(iteration): fixture Portal appears")
            if iteration == 1 { attach(app, name: "Portal Home") }

            let openStart = Date()
            portal.tap()
            XCTAssertTrue(app.staticTexts["Connected · Demo"].waitForExistence(timeout: 5), "iteration \(iteration): terminal opens")
            XCTAssertTrue(app.staticTexts["Portal terminal is ready."].exists, "iteration \(iteration): terminal content renders")
            let openTime = Date().timeIntervalSince(openStart) * 1_000
            if iteration == 1 { attach(app, name: "Portal Terminal") }

            var trace: [String] = []
            for _ in 0..<5 {
                switch next(2) {
                case 0:
                    trace.append("reconnect")
                    app.buttons["Reconnect terminal"].tap()
                    XCTAssertTrue(app.staticTexts["Connected · Demo"].waitForExistence(timeout: 3))
                default:
                    trace.append("back-reopen")
                    let back = app.navigationBars.buttons.element(boundBy: 0)
                    XCTAssertTrue(back.waitForExistence(timeout: 3))
                    back.tap()
                    XCTAssertTrue(app.navigationBars["Portals"].waitForExistence(timeout: 3))
                    let row = app.buttons["portal-row-demo-portal"]
                    XCTAssertTrue(row.waitForExistence(timeout: 3))
                    row.tap()
                    XCTAssertTrue(app.staticTexts["Connected · Demo"].waitForExistence(timeout: 3))
                }
            }

            let closeStart = Date()
            app.buttons["close-portal"].tap()
            let confirm = app.buttons["Close Portal"]
            XCTAssertTrue(confirm.waitForExistence(timeout: 3))
            confirm.tap()
            XCTAssertTrue(app.staticTexts["No Portals open"].waitForExistence(timeout: 5), "iteration \(iteration): confirmed close returns to empty state")
            let closeTime = Date().timeIntervalSince(closeStart) * 1_000
            trace.append("confirmed-close")
            metrics.append(PortalMonkeyIteration(iteration: iteration,
                launchToListMilliseconds: launchTime,
                openTerminalMilliseconds: openTime,
                closeMilliseconds: closeTime,
                actionTrace: trace))
            app.terminate()
        }

        let payload = try JSONEncoder().encode(metrics)
        let report = XCTAttachment(data: payload, uniformTypeIdentifier: "public.json")
        report.name = "iOS Portal monkey run · 15 iterations"
        report.lifetime = .keepAlways
        add(report)
        let averageLaunch = metrics.map(\.launchToListMilliseconds).reduce(0, +) / Double(metrics.count)
        let averageOpen = metrics.map(\.openTerminalMilliseconds).reduce(0, +) / Double(metrics.count)
        let averageClose = metrics.map(\.closeMilliseconds).reduce(0, +) / Double(metrics.count)
        print("PORTAL_MONKEY_METRICS iterations=15 seed=0x51C0FFEE averageLaunchMs=\(Int(averageLaunch)) averageOpenMs=\(Int(averageOpen)) averageCloseMs=\(Int(averageClose))")
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

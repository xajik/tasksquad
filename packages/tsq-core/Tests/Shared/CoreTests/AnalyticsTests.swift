import XCTest
@testable import TaskSquadCore

/// Ported behaviour of packages/daemon/analytics/amplitude.go.
final class AnalyticsTests: PlatformTestCase {
    func testDisabledOrKeylessClientsSendNothing() async {
        for (enabled, key) in [(false, "k"), (true, "")] {
            let recorder = AnalyticsRecorder()
            let analytics = Analytics(enabled: enabled, apiKey: key, deviceID: "d", appVersion: "1", transport: recorder)
            await analytics.enqueue("task_started", nil)
            await analytics.flush()
            let events = await recorder.events
            XCTAssertTrue(events.isEmpty)
        }
    }

    func testEventShapeQueueLimitAndIdentify() async {
        let recorder = AnalyticsRecorder()
        let analytics = Analytics(enabled: true, apiKey: "k", deviceID: "dev", appVersion: "", transport: recorder, flushInterval: .seconds(3600))
        await analytics.enqueue("task_started", ["task_id": .string("t1")])
        await analytics.enqueue("no_props", [:])
        for i in 0..<120 { await analytics.enqueue("bulk-\(i)", nil) }
        await analytics.flush()
        let events = await recorder.events
        XCTAssertEqual(events.count, 100, "at most 100 queued; the rest are dropped")
        XCTAssertEqual(events[0]["event_type"]?.string, "task_started")
        XCTAssertEqual(events[0]["device_id"]?.string, "dev")
        XCTAssertEqual(events[0]["properties"]?["task_id"]?.string, "t1")
        XCTAssertNil(events[0]["app_version"], "omitempty")
        XCTAssertNil(events[1]["properties"], "omitempty")
        XCTAssertNotNil(events[0]["time"]?.number)

        analytics.identify("me@example.com")
        try? await Task.sleep(for: .milliseconds(50))
        await analytics.flush()
        let identify = await recorder.events.last
        XCTAssertEqual(identify?["event_type"]?.string, "$identify")
        XCTAssertEqual(identify?["properties"]?["$set"]?["user_id"]?.string, "me@example.com")
    }
}

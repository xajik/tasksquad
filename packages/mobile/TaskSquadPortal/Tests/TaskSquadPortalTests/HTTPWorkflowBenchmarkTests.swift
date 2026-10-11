import XCTest
import TaskSquadPortal

final class HTTPWorkflowBenchmarkTests: XCTestCase {
    /// Identical boundaries and native transport on macOS and the iOS simulator.
    /// Measures the customer API pipeline; it does not measure UI rendering.
    func testMatchedPortalAPIWorkflow15Samples() async throws {
        let base = URL(string: "http://127.0.0.1:18743")!
        do { _ = try await URLSession.shared.data(from: base.appendingPathComponent("__test/state")) }
        catch { throw XCTSkip("Run with the isolated contract fixture to collect network timings.") }
        let api = PortalAPI(baseURL: base) { _ in "fixture-token" }
        var samples: [[String: Double]] = []
        for index in 0..<15 {
            let start = Date()
            _ = try await api.portals(projectID: "demo")
            let listed = Date()
            let result = try await api.createPortal(projectID: "demo", agentID: "agent")
            let created = Date()
            let detail = try await api.portal(id: result.id)
            XCTAssertEqual(detail.status, "pending")
            let opened = Date()
            try await api.closePortal(id: result.id)
            let records = try await api.portals(projectID: "demo")
            XCTAssertEqual(records.first { $0.id == result.id }?.status, "done")
            samples.append(["sample": Double(index+1), "list_ms": listed.timeIntervalSince(start)*1000, "create_ms": created.timeIntervalSince(listed)*1000, "get_ms": opened.timeIntervalSince(created)*1000, "close_and_list_ms": Date().timeIntervalSince(opened)*1000])
        }
        let data = try JSONSerialization.data(withJSONObject: samples, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        #if os(iOS)
        attachment.name = "iOS matched Portal API timings"
        #else
        attachment.name = "macOS matched Portal API timings"
        if let path = ProcessInfo.processInfo.environment["TSQ_API_METRICS"] { try data.write(to: URL(fileURLWithPath: path)) }
        #endif
        attachment.lifetime = .keepAlways; add(attachment)
        print("MATCHED_PORTAL_API_METRICS " + String(decoding: data, as: UTF8.self))
    }
}

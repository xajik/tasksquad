import XCTest
import TaskSquadPortal

final class HTTPWorkflowBenchmarkTests: XCTestCase {
    /// Identical boundaries and native transport on macOS and the iOS simulator.
    /// Measures the customer API pipeline; it does not measure UI rendering.
    @MainActor func testMatchedPortalAPIWorkflow15Samples() async throws {
        let base = URL(string: "http://127.0.0.1:18743")!
        do { _ = try await URLSession.shared.data(from: base.appendingPathComponent("__test/state")) }
        catch { throw XCTSkip("Run with the isolated contract fixture to collect network timings.") }
        let api = CustomerAPI(baseURL: base) { _ in "fixture-token" }
        let store = WorkspaceStore(api: api); store.projectID = "demo"
        var samples: [[String: Double]] = []
        for index in 0..<15 {
            let start = Date()
            _ = try await api.request(["portals"], query: ["team_id": "demo"])
            let listed = Date()
            let portal = await store.perform(.create(.portals, project: "demo", values: ["agent_id": .string("agent")]))
            let id = try XCTUnwrap(portal?["id"]?.string)
            let created = Date()
            let detail = CustomerRecord(try await api.request(["portals", id]))
            XCTAssertEqual(detail.status, "pending")
            let opened = Date()
            let closed = await store.perform(.closePortal(id))
            XCTAssertNotNil(closed)
            let records = CustomerRecord(try await api.request(["portals"], query: ["team_id": "demo"])).records("portals")
            XCTAssertEqual(records.first { $0.id == id }?.status, "done")
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

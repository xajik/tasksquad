import XCTest
@testable import TaskSquadCore

private actor TerminalTransport: HTTPTransport {
    var requests: [URLRequest] = []
    let status: Int
    init(status: Int = 204) { self.status = status }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        requests.append(request); return HTTPResult(data: Data(), status: status)
    }
}

final class ManagedTerminalTests: XCTestCase {
    private let target = ManagedTerminalTarget(agentID: "agent", taskID: "original-task", session: "tsq-original-session")
    func testInputPreservesUnicodeAndExactOwnershipThenClosesSameTask() async throws {
        let transport = TerminalTransport()
        let client = ManagedTerminalClient(port: 7374, transport: transport)
        let bytes = Data("café 猫\r".utf8)
        try await client.send(bytes, submit: true, pane: "%42", target: target)
        try await client.close(target)
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        for request in requests {
            XCTAssertEqual(request.url?.host, "127.0.0.1")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
            XCTAssertEqual(body["task_id"] as? String, "original-task")
            XCTAssertEqual(body["session"] as? String, "tsq-original-session")
        }
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(requests[0].httpBody)) as? [String: Any])
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(body["data"] as? String)), bytes)
        XCTAssertEqual(body["submit"] as? Bool, true)
        XCTAssertEqual(body["pane"] as? String, "%42")
        XCTAssertEqual(requests[1].url?.path, "/hooks/terminal/close")
    }
    func testUnavailableAndChangedSessionsFailWithoutRetry() async throws {
        for status in [404, 409, 501] {
            let transport = TerminalTransport(status: status)
            let client = ManagedTerminalClient(port: 7374, transport: transport)
            do { try await client.close(target); XCTFail("Must fail closed") }
            catch is ManagedTerminalError { }
            let requests = await transport.requests
            XCTAssertEqual(requests.count, 1)
        }
    }
}

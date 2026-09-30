import XCTest
@testable import TaskSquadCore

private actor CustomerTransport: HTTPTransport {
    var requests: [URLRequest] = []
    var responses: [HTTPResult]
    init(_ responses: [HTTPResult]) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.badServerResponse) }
        return responses.removeFirst()
    }
}

final class CustomerAPITests: XCTestCase, @unchecked Sendable {
    func testCustomerRequestsEncodeScopeAndNeverCarryDaemonAgentHeader() async throws {
        let transport = CustomerTransport([.init(data: Data(#"{"notes":[]}"#.utf8), status: 200)])
        let api = CustomerAPI(baseURL: URL(string: "https://worker.example/api/")!, transport: transport) { _ in "user-token" }
        _ = try await api.request(["teams", "team/a?x=1", "notes"], query: ["category": "a&b café"])
        let requests = await transport.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.percentEncodedPath, "/api/teams/team%2Fa%3Fx%3D1/notes")
        XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "a&b café")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer user-token")
        XCTAssertNil(request.value(forHTTPHeaderField: "X-TSQ-Agent"))
        XCTAssertThrowsError(try api.url(["teams", "..", "notes"]))
    }

    func testUnauthorizedRotatesOnceAndPreservesMutationBody() async throws {
        let transport = CustomerTransport([.init(data: Data(), status: 401), .init(data: Data(#"{"id":"task-1"}"#.utf8), status: 201)])
        let api = CustomerAPI(baseURL: URL(string: "https://worker.example")!, transport: transport) { force in force ? "new" : "old" }
        let body: JSONValue = .object(["body": .string("café 猫"), "scheduled_at": .number(1_900_000_000_000)])
        let result = try await api.request(["tasks"], method: "POST", body: body)
        XCTAssertEqual(result["id"]?.string, "task-1")
        let requests = await transport.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[1].value(forHTTPHeaderField: "Authorization"), "Bearer new")
        XCTAssertEqual(requests[0].httpBody, requests[1].httpBody)
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: requests[1].httpBody!), body)
    }

    func testNoRetryOnServerFailureAndBackendMessageSurvives() async throws {
        let transport = CustomerTransport([.init(data: Data(#"{"error":"pro_required"}"#.utf8), status: 403)])
        let api = CustomerAPI(baseURL: URL(string: "https://worker.example")!, transport: transport) { _ in "token" }
        do { _ = try await api.request(["portals"], method: "POST"); XCTFail("Expected error") }
        catch let error as CustomerAPIError { XCTAssertEqual(error.status, 403); XCTAssertEqual(error.message, "pro_required") }
        let requests = await transport.requests; XCTAssertEqual(requests.count, 1)
    }

    func testEmptyDeleteResponseAndMultipartBytes() async throws {
        let transport = CustomerTransport([.init(data: Data(), status: 204)])
        let api = CustomerAPI(baseURL: URL(string: "https://worker.example")!, transport: transport) { _ in "token" }
        let result = try await api.request(["tasks", "t", "messages", "m"], method: "DELETE")
        XCTAssertEqual(result, .null)
        let bytes = Data([0, 255, 13, 10, 42])
        let data = try CustomerAPI.multipart(body: .object(["body": .string("Hello 猫"), "auto_close": .bool(true), "close_steps": .array([.string("memory")]), "scheduled_at": .null]),
            files: [.init(name: "quote\"\r\n.png", mimeType: "image/png", data: bytes)], boundary: "test-boundary")
        XCTAssertNotNil(data.range(of: bytes))
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.contains("filename=\"quote___.png\""))
        XCTAssertTrue(text.contains("name=\"images\""))
        XCTAssertTrue(text.contains("Hello 猫\r\n"))
        XCTAssertFalse(text.contains("scheduled_at"))
        XCTAssertTrue(text.hasSuffix("--test-boundary--\r\n"))
    }

    func testSecureBrowserCallbackRejectsMissingStateWithoutConsumingLogin() async throws {
        let flow = try await LoginFlow.begin(dashboardURL: "https://tasksquad.ai", secureCallback: true)
        let browser = try XCTUnwrap(URLComponents(url: flow.browserURL, resolvingAgainstBaseURL: false))
        let callback = try XCTUnwrap(browser.queryItems?.first(where: { $0.name == "redirect_uri" })?.value)
        var callbackURL = try XCTUnwrap(URLComponents(string: callback))
        let valid = try XCTUnwrap(callbackURL.url)
        XCTAssertNotNil(callbackURL.queryItems?.first(where: { $0.name == "state" })?.value)
        callbackURL.query = nil
        var invalid = URLRequest(url: callbackURL.url!); invalid.httpMethod = "POST"
        invalid.httpBody = Data(#"{"id_token":"wrong"}"#.utf8)
        let rejected = try await NativeHTTPTransport().send(invalid)
        XCTAssertEqual(rejected.status, 404)
        var request = URLRequest(url: valid); request.httpMethod = "POST"
        request.httpBody = Data(#"{"id_token":"test","refresh_token":"refresh","email":"a@example.test","firebase_api_key":"public-key"}"#.utf8)
        let accepted = try await NativeHTTPTransport().send(request)
        XCTAssertEqual(accepted.status, 200)
        let result = try await flow.result()
        XCTAssertEqual(result.idToken, "test"); XCTAssertEqual(result.firebaseAPIKey, "public-key")
    }

    func testRecordHandlesBooleanAndNumericFlagsAndPlannerIdentity() throws {
        let record = CustomerRecord(try JSONDecoder().decode(JSONValue.self, from: Data(#"{"planner_id":"p","name":"Plan","paused":1,"auto_close":true,"phases":null}"#.utf8)))
        XCTAssertEqual(record.id, "p"); XCTAssertEqual(record.title, "Plan")
        XCTAssertTrue(record.flag("paused")); XCTAssertTrue(record.flag("auto_close"))
        XCTAssertEqual(record.records("phases"), [])
    }
}

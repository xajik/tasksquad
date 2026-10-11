import XCTest
@testable import TaskSquadPortal

private actor RecordingTransport: HTTPTransport {
    var last: URLRequest?
    func request() -> URLRequest? { last }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        last = request
        return HTTPResult(data: Data(#"{"token":"tsq_cli_x","expires_at":42}"#.utf8), status: 200)
    }
}

final class CustomerSessionTests: XCTestCase {
    func testTerminalSocketUsesSecureSchemeAndEncodesSession() throws {
        let api = CustomerAPI(baseURL: URL(string: "https://api.example.test")!) { _ in "t" }
        let url = try api.terminalSocketURL(sessionID: "a/b", ticket: "tk", replay: true)
        XCTAssertEqual(url.absoluteString, "wss://api.example.test/terminal/a%2Fb?replay=1&ticket=tk")
        let local = CustomerAPI(baseURL: URL(string: "http://127.0.0.1:18743")!) { _ in "t" }
        XCTAssertEqual(try local.terminalSocketURL(sessionID: "s", ticket: "k", replay: false).scheme, "ws")
    }
    func testAuthorizationExchangeSendsNoBearerToken() async throws {
        let transport = RecordingTransport()
        let api = CustomerAPI(baseURL: URL(string: "https://api.example.test")!) { _ in XCTFail("token requested"); return "" }
        let token = try await api.exchangeAuthorizationCode("c", verifier: "v", transport: transport)
        XCTAssertEqual(token.token, "tsq_cli_x")
        let request = await transport.request()
        XCTAssertNil(request?.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(request?.url?.path, "/mobile/authorization/exchange")
    }
}

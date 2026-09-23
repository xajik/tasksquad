import XCTest
@testable import TaskSquadCore

@MainActor final class LoginFlowTests: XCTestCase {
    func testExistingPortalCallbackContract() async throws {
        let flow = try await LoginFlow.begin(dashboardURL: "https://tasksquad.ai")
        let components = try XCTUnwrap(URLComponents(url: flow.browserURL, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/auth/cli")
        let callback = try XCTUnwrap(components.queryItems?.first(where: { $0.name == "redirect_uri" })?.value)
        let url = try XCTUnwrap(URL(string: callback))
        XCTAssertEqual(url.host, "localhost")
        let transport = NativeHTTPTransport()
        var preflight = URLRequest(url: url)
        preflight.httpMethod = "OPTIONS"
        let options = try await transport.send(preflight)
        XCTAssertEqual(options.status, 204)
        XCTAssertEqual(options.headers["access-control-allow-origin"], "*")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = Data(#"{"id_token":"test-id","refresh_token":"test-refresh","email":"test@example.invalid"}"#.utf8)
        let response = try await transport.send(request)
        XCTAssertEqual(response.status, 200)
        let result = try await flow.result()
        XCTAssertEqual(result.idToken, "test-id")
        XCTAssertEqual(result.refreshToken, "test-refresh")
        XCTAssertEqual(result.email, "test@example.invalid")
    }

    func testTimeoutClosesListener() async throws {
        let flow = try await LoginFlow.begin(dashboardURL: "https://tasksquad.ai", timeout: .milliseconds(20))
        do { _ = try await flow.result(); XCTFail("Expected timeout") }
        catch { XCTAssertTrue(error.localizedDescription.contains("timed out")) }
    }

    func testCancellationStopsPendingLogin() async throws {
        let flow = try await LoginFlow.begin(dashboardURL: "https://tasksquad.ai")
        let task = Task { try await flow.result() }
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") } catch { }
        await flow.cancel()
    }
}

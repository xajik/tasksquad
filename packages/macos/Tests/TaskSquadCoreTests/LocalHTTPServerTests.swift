import XCTest
@testable import TaskSquadCore

@MainActor final class LocalHTTPServerTests: XCTestCase {
    func testListenerHandlesRealNativeURLSessionRequest() async throws {
        let server = try LocalHTTPServer { request in
            .json(.object(["method": .string(request.method), "path": .string(request.path),
                           "body": .string(String(decoding: request.body, as: UTF8.self))]))
        }
        let port = try await server.start()
        XCTAssertGreaterThan(port, 0)
        do {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/hooks/stop?agent_id=one")!)
            request.httpMethod = "POST"
            request.httpBody = Data("unicode é猫".utf8)
            let result = try await NativeHTTPTransport().send(request)
            XCTAssertEqual(result.status, 200)
            let response = try JSONDecoder().decode(JSONValue.self, from: result.data)
            XCTAssertEqual(response["method"]?.string, "POST")
            XCTAssertEqual(response["path"]?.string, "/hooks/stop")
            XCTAssertEqual(response["body"]?.string, "unicode é猫")
        } catch { await server.stop(); throw error }
        await server.stop()
    }

    func testFramingAcrossPartialReads() throws {
        let prefix = Data("POST /hooks/stop HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4\r\n\r\n".utf8)
        XCTAssertNil(try HTTPRequestDecoder.decode(prefix + Data("ab".utf8), bodyLimit: 100))
        let result = try HTTPRequestDecoder.decode(prefix + Data("abcd".utf8), bodyLimit: 100)
        XCTAssertEqual(result?.body, Data("abcd".utf8))
        XCTAssertThrowsError(try HTTPRequestDecoder.decode(prefix, bodyLimit: 3))
    }

    func testChunkedBodiesAndTrailers() throws {
        let prefix = Data("POST /hooks/stop HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n".utf8)
        XCTAssertNil(try HTTPRequestDecoder.decode(prefix + Data("3\r\nab".utf8), bodyLimit: 100))
        let chunked = prefix + Data("3;key=value\r\nabc\r\n2\r\nde\r\n0\r\nX-Test: true\r\n\r\n".utf8)
        XCTAssertEqual(try HTTPRequestDecoder.decode(chunked, bodyLimit: 100)?.body, Data("abcde".utf8))
        XCTAssertThrowsError(try HTTPRequestDecoder.decode(chunked, bodyLimit: 4))
    }

    func testRejectsAmbiguousFramingAndUnboundedHeaders() {
        for raw in [
            "POST / HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 4\r\n\r\nabcd",
            "POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n",
            "POST / HTTP/1.1\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n",
            "GET http://remote.invalid/ HTTP/1.1\r\n\r\n",
            String(repeating: "A", count: 33 * 1024),
        ] { XCTAssertThrowsError(try HTTPRequestDecoder.decode(Data(raw.utf8), bodyLimit: 100)) }
    }

    func testOccupiedPortFailsStartupInsteadOfHanging() async throws {
        let first = try LocalHTTPServer { _ in .init() }
        let port = try await first.start()
        let second = try LocalHTTPServer(port: port) { _ in .init() }
        do { _ = try await second.start(); XCTFail("Second listener unexpectedly acquired occupied port") }
        catch { }
        await first.stop(); await second.stop()
    }
}

import XCTest
@testable import TaskSquadCore

/// A loopback port nothing listens on, so engine tests never take the real
/// daemon's hooks port (7374) — the engine always opens its hook listener, as Go does.
func freeLoopbackPort() async throws -> Int {
    let probe = try LocalHTTPServer { _ in .init() }
    let port = try await probe.start()
    await probe.stop()
    return Int(port)
}

/// The Go reference executable built by `make test-compatibility`.
func goOracle() throws -> URL {
    guard let path = ProcessInfo.processInfo.environment["TSQ_GO_ORACLE"] else { throw XCTSkip("Use make test-compatibility") }
    return URL(fileURLWithPath: path)
}

/// Polls `condition` until it holds; fails the test and throws on timeout.
func waitUntil(_ what: String, timeout: Duration = .seconds(20), isolation: isolated (any Actor)? = #isolation,
               _ condition: () async -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: timeout)
    while ContinuousClock.now < deadline {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(50))
    }
    XCTFail("Timed out: \(what)")
    throw CancellationError()
}

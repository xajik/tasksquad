@testable import TaskSquadCore

/// A loopback port nothing listens on, so engine tests never take the real
/// daemon's hooks port (7374) — the engine always opens its hook listener, as Go does.
func freeLoopbackPort() async throws -> Int {
    let probe = try LocalHTTPServer { _ in .init() }
    let port = try await probe.start()
    await probe.stop()
    return Int(port)
}

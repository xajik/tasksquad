import XCTest
@testable import TaskSquadCore

private struct RSTokens: TokenProvider { func token(forceRotation: Bool) async throws -> String { "token" } }

private actor PhasedServer {
    var responses: [String: Data] = [:]
    func set(_ phase: [String: Data]) { responses = phase }
    func handle(_ request: LocalHTTPRequest) -> LocalHTTPResponse {
        guard let body = responses[request.path] else { return .init(status: 404) }
        return .init(body: body)
    }
}

/// Skills, sub-agents and commands sync against the same two-phase server as Go
/// (Fixtures/resource-sync/server.json); the resulting work tree and lock contents
/// must equal Go's (phase1-tree.json, phase2-tree.json) — except Go's path-traversal
/// writes for a skill named "../escape", which Swift refuses.
final class ResourceSyncGoldenTests: XCTestCase {
    static func tree(_ root: URL) throws -> [String: String] {
        var out: [String: String] = [:]
        let base = root.resolvingSymlinksInPath().path
        let urls = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey])?.allObjects as? [URL] ?? []
        for url in urls where (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            out[String(url.resolvingSymlinksInPath().path.dropFirst(base.count + 1))] = try String(contentsOf: url, encoding: .utf8)
        }
        return out
    }

    func testSyncPhasesProduceGosTree() async throws {
        let fixtures = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil)?.appendingPathComponent("resource-sync"))
        let server = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("server.json"))) as? [String: [String: Any]])
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-rsg-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let home = root.appendingPathComponent("home"), work = root.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: work.appendingPathComponent(".agents/skills/tsq-team-skill"), withIntermediateDirectories: true)
        try Data("mine".utf8).write(to: work.appendingPathComponent(".agents/skills/tsq-team-skill/SKILL.md"))
        let phased = PhasedServer()
        let http = try LocalHTTPServer { await phased.handle($0) }
        let port = try await http.start()
        defer { Task { await http.stop() } }
        let config = try DaemonConfiguration.parse("[[agents]]\nid = 'agent-a'\nname = 'A'\ncommand = 'claude'\nwork_dir = '\(work.path)'\n")
        let paths = TaskSquadPaths(home: home)
        for phase in ["phase1", "phase2"] {
            let encoded = try XCTUnwrap(server[phase]).mapValues { (try? JSONSerialization.data(withJSONObject: $0)) ?? Data() }
            await phased.set(encoded)
            let sync = ResourceSync(api: WorkerAPI(baseURL: "http://127.0.0.1:\(port)"), tokens: RSTokens(), paths: paths, agents: config.agents) { _ in }
            await sync.syncAll()
            let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("\(phase)-tree.json"))) as? [String: Any])
            let actual = try Self.tree(work)
            let goFiles = expected.filter { !$0.key.hasPrefix("LOCK:") && !$0.key.contains("/escape/") }.mapValues { $0 as? String ?? "" }
            XCTAssertEqual(Set(actual.keys), Set(goFiles.keys), phase)
            for (path, content) in goFiles { XCTAssertEqual(actual[path], content, "\(phase) \(path)") }
            XCTAssertFalse(actual.keys.contains { $0.contains("escape") }, "Swift never writes outside the managed folders")
            for kind in ["skills", "agents", "commands"] {
                let locks = (try? FileManager.default.contentsOfDirectory(atPath: paths.root.path)) ?? []
                let file = try XCTUnwrap(locks.first { $0.hasPrefix(kind + "-") && $0.hasSuffix(".lock") }, "\(phase) \(kind) lock")
                let mine = try JSONSerialization.jsonObject(with: Data(contentsOf: paths.root.appendingPathComponent(file))) as? NSDictionary
                var goLock = (expected["LOCK:" + kind] as? [String: Any]) ?? [:]
                goLock = goLock.filter { !$0.key.contains("/") }
                XCTAssertEqual(mine, goLock as NSDictionary, "\(phase) \(kind) lock")
            }
        }
    }
}

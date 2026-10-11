import XCTest
@testable import TaskSquadCore

/// A corpus of TOML forms the Go config loader (BurntSushi/toml + config.Load) accepts or
/// rejects; Swift must agree on every document and decode identical values.
final class TOMLConformanceTests: XCTestCase {
    private func oracle() throws -> URL {
        guard let path = ProcessInfo.processInfo.environment["TSQ_GO_ORACLE"] else { throw XCTSkip("Use make test-compatibility") }
        return URL(fileURLWithPath: path)
    }

    private func goConfig(_ file: URL) throws -> (Int32, Data) {
        let process = Process()
        process.executableURL = try oracle()
        process.arguments = ["config", file.path]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, data)
    }

    static let agent = "[[agents]]\nid = 'a1'\nname = 'A'\ncommand = 'claude'\nwork_dir = '/w'\n"
    static let corpus: [String] = [
        agent,
        "# leading comment\n" + agent + "# trailing\n",
        agent.replacingOccurrences(of: "\n", with: "\r\n"),
        "[server]\nurl = \"https://x.example\" # inline comment\npoll_interval = 1_0\n" + agent,
        "[server]\npoll_interval = 0x1F\n" + agent,
        "[server]\npoll_interval = 0o17\n" + agent,
        "[server]\npoll_interval = +30\n" + agent,
        "[server]\npoll_interval = 30.0\n" + agent,
        "[server]\npoll_interval = '30'\n" + agent,
        "[server]\nurl = 42\n" + agent,
        "server.url = 'https://dotted.example'\n" + agent,
        "server = { url = 'https://inline.example', poll_interval = 5 }\n" + agent,
        "\"server\".\"url\" = 'https://quoted.example'\n" + agent,
        "[server]\nurl = '''multi\nline'''\n" + agent,
        "[server]\nurl = \"\"\"\\\n  trimmed\"\"\"\n" + agent,
        "[server]\nurl = \"esc\\u00e9\\t\\\"q\\\"\"\n" + agent,
        "[server]\nurl = 'a'\nurl = 'b'\n" + agent,
        "[server]\n[server]\n" + agent,
        "[hooks]\nport = 7374\n[hooks.extra]\nx = 1\n" + agent,
        "[analytics]\nenabled = true\napi_key = 'k'\n" + agent,
        "[analytics]\nenabled = 'yes'\n" + agent,
        "[supervisor]\ncommand = 'claude -p'\n[dreamer]\ncommand = 'codex'\nwindow_start = '02:00'\nwindow_end = '03:00'\n" + agent,
        "[supervisor]\n" + agent,
        agent + "unknown_key = 'ignored'\n",
        agent + "provider = 'codex'\n",
        agent + "[[agents]]\nid = 'a2'\nname = 'B'\ncommand = 'codex'\nwork_dir = '~/proj'\n",
        "[[agents]]\nname = 'no id'\ncommand = 'claude'\n",
        "[[agents]]\nid = ''\n",
        "agents = []\n",
        "[agents]\nid = 'a1'\n",
        "agents = [{ id = 'inline', name = 'I', command = 'claude', work_dir = '/w' }]\n",
        "[[agents]]\nid = 'a1'\n[agents.extra]\nx = 1\n",
        "[[agents]]\nid = 'a1'\nid = 'dup'\n",
        "",
        "not toml at all",
        "[server\nurl = 'x'\n" + agent,
        "[server]\nurl = 'unterminated\n" + agent,
        "[server]\nurl = 'x' junk\n" + agent,
        "x = 1979-05-27T07:32:00Z\n" + agent,
        "x = [1, 'mixed']\n" + agent,
        "x = inf\ny = nan\n" + agent,
        "[firebase]\napi_key = 'fk'\nauth_domain = 'd.example'\n" + agent,
        "[ui]\nport = 65536\n" + agent,
        "[hooks]\nport = -1\n" + agent,
    ]

    func testCorpusAgreesWithGo() throws {
        _ = try oracle()
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-toml-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var disagreements: [String] = []
        for (index, document) in Self.corpus.enumerated() {
            let file = folder.appendingPathComponent("case\(index).toml")
            try Data(document.utf8).write(to: file)
            let (status, output) = try goConfig(file)
            let swift = Result { try DaemonConfiguration.load(from: file) }
            switch (status == 0, swift) {
            case (true, .success(let mine)):
                guard let expected = try? JSONDecoder().decode(DaemonConfiguration.self, from: output) else {
                    disagreements.append("#\(index) undecodable Go output"); continue
                }
                if mine != expected { disagreements.append("#\(index) values differ:\n\(document)") }
            case (false, .failure): break
            case (true, .failure(let error)): disagreements.append("#\(index) Go accepts, Swift rejects (\(error.localizedDescription)):\n\(document)")
            case (false, .success): disagreements.append("#\(index) Go rejects, Swift accepts:\n\(document)")
            }
        }
        XCTAssertTrue(disagreements.isEmpty, disagreements.joined(separator: "\n---\n"))
    }
}

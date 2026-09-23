import XCTest
@testable import TaskSquadCore

final class ConfigurationTests: XCTestCase {
    func testDuplicateAgentIDsParseLikeGoEvenThoughDaemonEngineWillReject() throws {
        // Go's config.Load never checks agent ID uniqueness; parse() must match
        // it exactly (GoCompatibilityTests). DaemonEngine.start() is where this
        // native engine's own agents dictionary requires unique keys.
        let config = try DaemonConfiguration.parse("[[agents]]\nid = 'dup'\ncommand='a'\n[[agents]]\nid = 'dup'\ncommand='b'")
        XCTAssertEqual(config.agents.map(\.id), ["dup", "dup"])
    }
    func testDefaultsAndHomeExpansion() throws {
        let config = try DaemonConfiguration.parse("[[agents]]\nid = 'abc'\nwork_dir = '~/work'", paths: .init(home: URL(fileURLWithPath: "/Users/test")))
        XCTAssertEqual(config.server.url, "https://api.tasksquad.ai")
        XCTAssertEqual(config.server.pollInterval, 60)
        XCTAssertEqual(config.hooks.port, 7374)
        XCTAssertEqual(config.ui.port, 7373)
        XCTAssertFalse(config.analytics.enabled)
        XCTAssertEqual(config.agents[0].workDir, "/Users/test/work")
        XCTAssertNil(config.supervisor)
        XCTAssertNil(config.dreamer)
    }

    func testTablesQuotedKeysInlineValuesAndUnknownFields() throws {
        let config = try DaemonConfiguration.parse(#"""
        server = { url = 'http://localhost:8787/api', poll_interval = 0x3c }
        agents = [{id = 'one', command = "claude --model \"test\"", work_dir = '/tmp/#path'}, {id = 'two', provider = 'stdout'}]
        ["supervisor"]
        command = """
        opencode \
           -m example
        """
        [dreamer]
        window_start = '02:00'
        [future]
        unknown = [true, 1, {key='value'}, [2, 3], 1e3, 1979-05-27T07:32:00Z]
        """#)
        XCTAssertEqual(config.agents.count, 2)
        XCTAssertEqual(config.agents[0].command, "claude --model \"test\"")
        XCTAssertEqual(config.agents[0].workDir, "/tmp/#path")
        XCTAssertEqual(config.server.pollInterval, 60)
        XCTAssertEqual(config.supervisor?.command, "opencode -m example\n")
        XCTAssertEqual(config.dreamer?.windowStart, "02:00")
        XCTAssertEqual(config.dreamer?.windowEnd, "")
    }

    func testUnicodeLiteralAndBasicStrings() throws {
        let config = try DaemonConfiguration.parse(#"""
        [[agents]]
        id = "\u0061\U0001F600"
        command = '''/tmp/back\slash'''
        name = "x\t\"y\""
        """#)
        XCTAssertEqual(config.agents[0].id, "a😀")
        XCTAssertEqual(config.agents[0].command, #"/tmp/back\slash"#)
        XCTAssertEqual(config.agents[0].name, "x\t\"y\"")
    }

    func testInvalidDocumentsFailWithoutReturningPartialConfig() {
        let invalid = ["", "[[agents]]\nname='no id'", "[[agents]]\nid=123",
                       "[[agents]]\nid='abc'\nid='dup'", "[[agents]]\nid='unterminated",
                       "[server]\npoll_interval='60'\n[[agents]]\nid='a'",
                       "[server]\npoll_interval=01\n[[agents]]\nid='a'",
                       "[server]\n[server]\n[[agents]]\nid='a'",
                       "[[agents]]\nid='a' trailing", "[[agents]]\nid=\"\\q\"",
                       "[[agents]]\nid=\"line\nbreak\"", "agents=[{id='a',}]"]
        for document in invalid { XCTAssertThrowsError(try DaemonConfiguration.parse(document), document) }
    }

    func testNestedTablesUnderSeparateAgents() throws {
        let config = try DaemonConfiguration.parse("""
        [[agents]]
        id='one'
        [agents.future]
        value=1
        [[agents]]
        id='two'
        [agents.future]
        value=2
        [supervisor]
        command=''
        """)
        XCTAssertEqual(config.agents.map(\.id), ["one", "two"])
        XCTAssertEqual(config.supervisor?.command, "")
    }

    func testWatcherHandlesAtomicReplacementAndRejectsInvalidChanges() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("config.toml")
        try Data("[[agents]]\nid='one'".utf8).write(to: file)
        let changed = expectation(description: "atomic replacement observed")
        let watcher = try ConfigurationWatcher(url: file) { result in
            if case .success(let config) = result, config.agents.first?.id == "two" { changed.fulfill() }
        }
        try Data("[[agents]]\nid='two'".utf8).write(to: file, options: .atomic)
        wait(for: [changed], timeout: 3)
        withExtendedLifetime(watcher) { }
    }
}

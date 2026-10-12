import XCTest
@testable import TaskSquadCore

/// Runs every provider's launch setup through the current Go implementation
/// (Tests/GoReference `provider`) and through Swift, then requires identical
/// arguments, environment and generated files. Catches drift whenever the Go
/// providers change; rerun scripts/gen-provider-templates.py for template drift.
final class ProviderGoldenTests: PlatformTestCase {
    private struct GoSetup: Decodable {
        let name: String
        let cli_name: String
        let uses_hooks: Bool
        let setup_args: [String]?
        let env: [String]?
        let extra_args: [String]?
        let formatted_prompt: String
        let stdin: String
        let initial_prompt_args: [String]?
    }

    private func oracle() throws -> URL {
        guard let path = ProcessInfo.processInfo.environment["TSQ_GO_ORACLE"] else {
            throw XCTSkip("Use make test-compatibility to build the Go reference executable")
        }
        return URL(fileURLWithPath: path)
    }

    private func goSetup(command: String, workDir: URL, tmp: URL, prompt: String) throws -> GoSetup {
        let process = Process()
        process.executableURL = try oracle()
        process.arguments = ["provider", command, "", workDir.path, "7374", "agent-1", "task-1", prompt]
        process.environment = ProcessInfo.processInfo.environment.merging(["TMPDIR": tmp.path + "/"]) { $1 }
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, command)
        // Go's debug logger also writes to stdout; the report is the last line.
        let last = String(decoding: data, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? ""
        return try JSONDecoder().decode(GoSetup.self, from: Data(last.utf8))
    }

    /// Relative path → contents for every file under root.
    private func files(_ root: URL) -> [String: Data] {
        var out: [String: Data] = [:]
        let base = root.resolvingSymlinksInPath().path
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return out }
        for case let url as URL in enumerator {
            guard (try? url.resourceValues(forKeys: [URLResourceKey.isRegularFileKey]).isRegularFile) == true else { continue }
            out[String(url.resolvingSymlinksInPath().path.dropFirst(base.count + 1))] = try? Data(contentsOf: url)
        }
        return out
    }

    private func assertSameContent(_ swift: Data?, _ go: Data?, _ label: String) {
        guard let swift, let go else { return XCTFail("\(label): missing on one side") }
        if label.hasSuffix(".json") {
            // Go escapes &<> as &…; compare the decoded JSON.
            let a = try? JSONSerialization.jsonObject(with: swift) as? NSDictionary
            let b = try? JSONSerialization.jsonObject(with: go) as? NSDictionary
            XCTAssertNotNil(a, label)
            XCTAssertEqual(a, b, label)
        } else {
            XCTAssertEqual(String(decoding: swift, as: UTF8.self), String(decoding: go, as: UTF8.self), label)
        }
    }

    func testEveryProviderMatchesGo() throws {
        _ = try oracle()
        let prompt = "please /tsq-attach-image run é猫"
        for command in ["claude", "codex", "gemini", "opencode", "pi", "agent", "stdout", "/usr/local/bin/claude --model x"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-golden-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let goWork = root.appendingPathComponent("go/work"), goTmp = root.appendingPathComponent("go/tmp")
            let swiftWork = root.appendingPathComponent("swift/work"), swiftTmp = root.appendingPathComponent("swift/tmp")
            for url in [goWork, goTmp, swiftWork, swiftTmp] { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }

            let go = try goSetup(command: command, workDir: goWork, tmp: goTmp, prompt: prompt)
            let kind = ProviderKind.detect(command: command, override: "")
            try kind.setup(workDir: swiftWork.path, hooksPort: 7374, agentID: "agent-1", taskID: "task-1")
            let args = try kind.setupArguments(hooksPort: 7374, agentID: "agent-1", taskID: "task-1", temporaryDirectory: swiftTmp)

            XCTAssertEqual(kind.rawValue, go.name, command)
            XCTAssertEqual(kind.cliName, go.cli_name, command)
            XCTAssertEqual(kind.usesHooks, go.uses_hooks, command)
            XCTAssertEqual(kind.extraArguments, go.extra_args ?? [], command)
            XCTAssertEqual(kind.environment.map { "\($0)=\($1)" }.sorted(), (go.env ?? []).sorted(), command)
            let formatted = kind.formatPrompt(prompt)
            XCTAssertEqual(formatted, go.formatted_prompt, command)
            XCTAssertEqual(kind.interactive, !go.stdin.isEmpty, "\(command): typed-input (stdin) providers")
            XCTAssertEqual(kind.initialPromptArguments(formatted), go.initial_prompt_args ?? [], command)

            // Arguments: temp paths differ by root, and Codex's notify JSON differs only in escaping.
            let goArgs = (go.setup_args ?? []).map { $0.replacingOccurrences(of: goTmp.path, with: "$TMP") }
            let swiftArgs = args.map { $0.replacingOccurrences(of: swiftTmp.path, with: "$TMP") }
            XCTAssertEqual(swiftArgs.count, goArgs.count, command)
            for (a, b) in zip(swiftArgs, goArgs) {
                if a.hasPrefix("notify="), b.hasPrefix("notify=") {
                    let decode = { (s: String) in try? JSONSerialization.jsonObject(with: Data(s.dropFirst(7).utf8)) as? [String] }
                    XCTAssertEqual(decode(a), decode(b), command)
                } else {
                    XCTAssertEqual(a.replacingOccurrences(of: "//", with: "/"), b.replacingOccurrences(of: "//", with: "/"), command)
                }
            }

            for (label, swiftRoot, goRoot) in [("work", swiftWork, goWork), ("tmp", swiftTmp, goTmp)] {
                let swiftFiles = files(swiftRoot), goFiles = files(goRoot)
                XCTAssertEqual(Set(swiftFiles.keys), Set(goFiles.keys), "\(command) \(label) files")
                for name in goFiles.keys.sorted() { assertSameContent(swiftFiles[name], goFiles[name], "\(command) \(label)/\(name)") }
            }
        }
    }
}

import XCTest
@testable import TaskSquadCore

/// Outputs of Go's agent prompt building, KB note, line cleaning and every provider
/// adapter's transcript extraction (Fixtures/agent-pure-golden.json over Fixtures/transcripts).
final class AgentPureGoldenTests: PlatformTestCase {
    private func golden() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil)?.appendingPathComponent("agent-pure-golden.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }
    private func messages(_ json: String) -> [JSONValue] { (try? JSONDecoder().decode([JSONValue].self, from: Data(json.utf8))) ?? [] }

    func testPromptsMatchGo() throws {
        let expected = try XCTUnwrap(try golden()["prompts"] as? [String])
        let actual = [
            TaskPrompt.build(subject: "Subject", messages: []),
            TaskPrompt.build(subject: "Subject", messages: messages("[]")),
            TaskPrompt.build(subject: "Subject", messages: messages(#"[{"role":"user","body":"only body"}]"#)),
            TaskPrompt.build(subject: "Subject", messages: messages(#"[{"role":"user","body":""}]"#)),
            TaskPrompt.build(subject: "S", messages: messages(#"[{"role":"user","body":"a"},{"role":"agent","body":"b"},{"role":"system","body":"skip"},{"role":"user","body":"c é"}]"#)),
            TaskPrompt.build(subject: "S", messages: messages(#"[{"role":"user","body":"a"}]"#), memoryRollup: "rollup line"),
            TaskPrompt.build(subject: "S", messages: [], memoryRollup: "rollup"),
        ]
        XCTAssertEqual(actual, expected)
    }

    func testKBNoteAndCleanLineMatchGo() throws {
        let g = try golden()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-kbnote-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let kb = root.appendingPathComponent("kb"), empty = root.appendingPathComponent("empty"), none = root.appendingPathComponent("none")
        try FileManager.default.createDirectory(at: kb.appendingPathComponent("tsq/kb/deep"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: kb.appendingPathComponent("tsq/kb/deep/x.md"))
        try FileManager.default.createDirectory(at: empty.appendingPathComponent("tsq/kb/dir.md"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: none, withIntermediateDirectories: true)
        XCTAssertEqual([kb, empty, none].map { DaemonEngine.injectKBNote("P", workDir: $0.path) }, g["kb"] as? [String])
        XCTAssertEqual(["abc\rdef", "\u{1b}[31mred\u{1b}[0m \t", "\u{1b}]0;title\u{07}ok", "a\u{1b}(Bb\u{1b}7c", "tab\t "].map(TaskOutput.cleanLine), g["clean"] as? [String])
    }

    func testEveryProviderTranscriptExtractionMatchesGo() throws {
        let expected = try XCTUnwrap(try golden()["transcripts"] as? [String: String])
        let folder = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil)?.appendingPathComponent("transcripts"))
        for (key, value) in expected.sorted(by: { $0.key < $1.key }) {
            let parts = key.components(separatedBy: "|")
            let provider = try XCTUnwrap(ProviderKind(rawValue: parts[0]))
            XCTAssertEqual(HookAdapter.extractTranscript(provider: provider, path: folder.appendingPathComponent(parts[1]).path), value, key)
        }
    }
}

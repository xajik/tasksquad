import XCTest
@testable import TaskSquadCore

/// Ports packages/daemon/provider/resume_test.go and agent/resume_test.go.
final class ResumeTests: PlatformTestCase {
    private let id = "6f75c202-a633-4804-8b23-5937aa47f17f"

    func testValidResumeID() {
        for (value, valid) in [(id, true), ("01a14e55-4b15-7600-9b0b-ea0c89", true), ("", false), ("--dangerously-skip-permissions", false),
                               ("-x", false), ("a b", false), ("../../etc/passwd", false), ("a..b", false), ("a/b", false)] {
            XCTAssertEqual(ProviderKind.validResumeID(value), valid, value)
        }
    }

    func testResumableProviders() {
        XCTAssertEqual(Set(ProviderKind.allCases.filter(\.resumable)), [.claudeCode, .codex, .gemini, .opencode, .pi])
        XCTAssertFalse(ProviderKind.strictSessionPin(provider: "gemini"), "Gemini's session id only records, never gates hooks")
        XCTAssertTrue(ProviderKind.strictSessionPin(provider: "opencode"))
        XCTAssertTrue(ProviderKind.strictSessionPin(provider: ""))
    }

    func testResumeArguments() {
        XCTAssertEqual(ProviderKind.claudeCode.resumeArguments(["--settings", "/s.json"], id: id), ["--settings", "/s.json", "--resume", id])
        let codex = ProviderKind.codex.resumeArguments(["--no-alt-screen", "-c", "notify=[]"], id: id)
            + ProviderKind.codex.initialPromptArguments("hello")
        XCTAssertEqual(codex, ["resume", "--no-alt-screen", "-c", "notify=[]", id, "--", "hello"])
        XCTAssertEqual(ProviderKind.gemini.resumeArguments(["-m", "x"], id: id), ["-m", "x", "--resume", id])
        XCTAssertEqual(ProviderKind.opencode.resumeArguments(["--print-logs"], id: "ses_abc"), ["--print-logs", "--session", "ses_abc"])
        XCTAssertEqual(ProviderKind.pi.resumeArguments(["-p", "reply"], id: id), ["--session", id, "-p", "reply"])
    }

    func testClaudeCanResumeOnlyFromItsLocalStore() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let environment = ["CLAUDE_CONFIG_DIR": root.path]
        let resumes1 = await ProviderKind.claudeCode.canResume(id: id, environment: environment)
        XCTAssertFalse(resumes1)
        let project = root.appendingPathComponent("projects/-Users-me-repo")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try Data("{}\n".utf8).write(to: project.appendingPathComponent(id + ".jsonl"))
        let resumes2 = await ProviderKind.claudeCode.canResume(id: id, environment: environment)
        XCTAssertTrue(resumes2)
        let resumes3 = await ProviderKind.claudeCode.canResume(id: "*", environment: environment)
        XCTAssertFalse(resumes3)
    }

    func testCodexCanResumeMatchesWholeRolloutNames() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let environment = ["CODEX_HOME": root.path]
        let resumes4 = await ProviderKind.codex.canResume(id: id, environment: environment)
        XCTAssertFalse(resumes4)
        let day = root.appendingPathComponent("sessions/2026/10/18")
        try FileManager.default.createDirectory(at: day, withIntermediateDirectories: true)
        try Data("{}\n".utf8).write(to: day.appendingPathComponent("rollout-2026-10-18T17-26-15-\(id).jsonl"))
        let resumes5 = await ProviderKind.codex.canResume(id: id, environment: environment)
        XCTAssertTrue(resumes5)
        let resumes6 = await ProviderKind.codex.canResume(id: "5937aa47f17f", environment: environment)
        XCTAssertFalse(resumes6, "a partial id must not match")
    }

    func testGeminiCanResumeFromAChatFileNamingTheSession() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let environment = ["HOME": home.path]
        let gemini = ProviderKind.gemini
        let missing = await gemini.canResume(id: id, environment: environment)
        XCTAssertFalse(missing)
        let chats = home.appendingPathComponent(".gemini/tmp/0123abcd/chats")
        try FileManager.default.createDirectory(at: chats, withIntermediateDirectories: true)
        try Data(#"{"sessionId": "\#(id)", "messages": []}"#.utf8).write(to: chats.appendingPathComponent("session-2026-10-28T09-00-6f75c202.json"))
        let found = await gemini.canResume(id: id, environment: environment)
        XCTAssertTrue(found)
        let partial = await gemini.canResume(id: "6f75c202", environment: environment)
        XCTAssertFalse(partial, "a partial id must not match")
    }

    func testOpenCodeAsksTheCLIForTheProjectsSessions() async throws {
        let sessionID = "ses_f07f24b9affeNBpP0gLeMlv0Zj"
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let project = dir.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        // A stand-in CLI that lists the session only when run in the project dir.
        let cli = dir.appendingPathComponent("opencode")
        try Data("""
        #!/bin/sh
        [ "$1 $2 $3 $4" = "session list --format json" ] || exit 2
        case "$PWD" in *"/project") echo '[{"id":"\(sessionID)"}]' ;; *) echo '[]' ;; esac
        """.utf8).write(to: cli)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: cli.path)
        let environment = ProcessInfo.processInfo.environment
        let listed = await ProviderKind.opencode.canResume(id: sessionID, command: cli.path + " --print-logs", workDir: project.path, environment: environment)
        XCTAssertTrue(listed)
        let otherProject = await ProviderKind.opencode.canResume(id: sessionID, command: cli.path, workDir: dir.path, environment: environment)
        XCTAssertFalse(otherProject)
        let noCLI = await ProviderKind.opencode.canResume(id: sessionID, command: dir.appendingPathComponent("missing").path, workDir: project.path, environment: environment)
        XCTAssertFalse(noCLI)
        XCTAssertFalse(ProviderKind.openCodeListHas(Data("not json".utf8), id: sessionID))
    }

    func testPiCanResumeFromItsSessionStore() async throws {
        let piID = "01a1807b-d4cf-732f-a57d-cc9414b962bd"
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let environment = ["HOME": home.path]
        let repo = home.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        let missing = await ProviderKind.pi.canResume(id: piID, workDir: repo.path, environment: environment)
        XCTAssertFalse(missing)
        let project = home.appendingPathComponent(".pi/agent/sessions/--repo--")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        try Data(#"{"type":"session","version":3,"id":"\#(piID)","cwd":"\#(repo.path)"}"#.utf8 + Data("\n{}\n".utf8))
            .write(to: project.appendingPathComponent("2026-10-28T03-00-00-000Z_\(piID).jsonl"))
        let found = await ProviderKind.pi.canResume(id: piID, workDir: repo.path, environment: environment)
        XCTAssertTrue(found)
        let otherDirectory = await ProviderKind.pi.canResume(id: piID, workDir: home.path, environment: environment)
        XCTAssertFalse(otherDirectory, "a session from another directory must not resume (Pi would ask to fork it)")
        let partial = await ProviderKind.pi.canResume(id: "cc9414b962bd", workDir: repo.path, environment: environment)
        XCTAssertFalse(partial, "a partial id must not match")
        let elsewhere = await ProviderKind.pi.canResume(id: piID, workDir: repo.path, environment: environment.merging(["PI_CODING_AGENT_SESSION_DIR": home.path]) { $1 })
        XCTAssertFalse(elsewhere, "PI_CODING_AGENT_SESSION_DIR replaces the default store")
    }

    func testPiSessionIDComesFromItsSessionFileName() {
        let piID = "01a1807b-d4cf-732f-a57d-cc9414b962bd"
        XCTAssertEqual(HookAdapter.piSessionID(transcriptPath: "/h/.pi/agent/sessions/--r--/2026-10-12T04-10-46-928Z_\(piID).jsonl"), piID)
        for path in ["", "/t", "/x/no-underscore.jsonl", "/x/a_b_c.jsonl"] { XCTAssertEqual(HookAdapter.piSessionID(transcriptPath: path), "", path) }
        let body = Data(#"{"stop_reason":"idle","message":"hi","transcript_path":"/s/2026_\#(piID).jsonl"}"#.utf8)
        XCTAssertEqual(HookAdapter.parseStop(provider: "pi", body: body, isFailure: false).sessionID, piID)
    }

    func testGeminiAndOpenCodeStopsCarryTheirSession() {
        let body = Data(#"{"reason":"end_turn","stop_reason":"idle","session_id":"s-1","message":"m"}"#.utf8)
        XCTAssertEqual(HookAdapter.parseStop(provider: "gemini", body: body, isFailure: false).sessionID, "s-1")
        XCTAssertEqual(HookAdapter.parseStop(provider: "opencode", body: body, isFailure: false).sessionID, "s-1")
    }

    func testResumePromptHoldsOnlyTheUnansweredReplies() {
        func message(_ role: String, _ body: String) -> JSONValue { .object(["role": .string(role), "body": .string(body)]) }
        XCTAssertEqual(TaskPrompt.resume(messages: [message("user", "fix the bug"), message("agent", "which one?"),
                                                    message("user", "the login one"), message("user", "  and add a test  ")]),
                       "the login one\n\nand add a test")
        XCTAssertEqual(TaskPrompt.resume(messages: [message("user", "fix"), message("agent", "done")]), TaskPrompt.resumeInterrupted)
        XCTAssertEqual(TaskPrompt.resume(messages: []), TaskPrompt.resumeInterrupted)
    }

    func testDetachReason() throws {
        var waiting = AgentState()
        let generation = try waiting.beginTask("t")
        XCTAssertTrue(waiting.openedSession("s", generation: generation))
        XCTAssertTrue(waiting.detachReason() == (false, false), "a fresh spawn's mid-turn crash still fails the task")
        try waiting.transition(.hookStop)
        XCTAssertTrue(waiting.detachReason() == (true, false))

        var resumed = AgentState()
        let second = try resumed.beginTask("t")
        XCTAssertTrue(resumed.openedSession("s", generation: second))
        resumed.markResumed()
        XCTAssertTrue(resumed.detachReason() == (true, true), "a resume that never fired a hook failed")
        XCTAssertTrue(resumed.pinCLISessionID("cli"))
        XCTAssertTrue(resumed.detachReason() == (false, false))

        XCTAssertTrue(waiting.beginCompletion(generation: generation))
        XCTAssertTrue(waiting.detachReason() == (false, false), "already completing")
        resumed.reset()
        try resumed.beginTask("next")
        XCTAssertFalse(resumed.resumed, "a new task starts fresh")
    }

    func testClaudeNotificationCarriesItsSessionID() {
        let body = Data(#"{"message":"Claude needs your permission","session_id":"cli-1"}"#.utf8)
        XCTAssertEqual(HookAdapter.notificationSessionID(provider: "", body: body), "cli-1")
        XCTAssertEqual(HookAdapter.notificationSessionID(provider: "claude-code", body: body), "cli-1")
        XCTAssertEqual(HookAdapter.notificationSessionID(provider: "gemini", body: body), "cli-1")
        XCTAssertEqual(HookAdapter.notificationSessionID(provider: "opencode", body: body), "")
    }

    func testUntrackedSessionsAreSweptAfterTheGracePeriodOrFromAPreviousDaemon() {
        let now = Date(), started = now.addingTimeInterval(-60)
        XCTAssertTrue(OrphanSweep.isUntracked(created: now.addingTimeInterval(-3600), now: now, startedAt: started, owned: false))
        XCTAssertFalse(OrphanSweep.isUntracked(created: now.addingTimeInterval(-10), now: now, startedAt: started, owned: false))
        XCTAssertTrue(OrphanSweep.isUntracked(created: now.addingTimeInterval(-90), now: now, startedAt: started, owned: false),
                      "a session from before this daemon started needs no grace")
        XCTAssertFalse(OrphanSweep.isUntracked(created: now.addingTimeInterval(-3600), now: now, startedAt: started, owned: true))
        XCTAssertFalse(OrphanSweep.isUntracked(created: nil, now: now, startedAt: started, owned: false))
    }
}

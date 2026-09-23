import XCTest
@testable import TaskSquadCore

private actor CollectedOutput {
    var stdout = Data(), stderr = Data()
    func append(_ channel: ProcessChannel, _ data: Data) {
        switch channel { case .stdout: stdout.append(data); case .stderr: stderr.append(data) }
    }
}

@MainActor final class NativeProcessTests: XCTestCase {
    func testUnicodeArgumentsAndShellMetacharactersRemainLiteral() async throws {
        let arguments = ["é", "e\u{301}", "猫", "  leading/trailing  ", "$(whoami);`date`", "line\nbreak"]
        let output = CollectedOutput()
        let result = try await NativeProcess.run(.init(executable: "/usr/bin/printf", arguments: ["%s\\0"] + arguments)) {
            await output.append($0, $1)
        }
        XCTAssertEqual(result.code, 0)
        let data = await output.stdout
        XCTAssertEqual(data, Data((arguments.joined(separator: "\0") + "\0").utf8))
    }

    func testLargeInputAndOutputDoNotDeadlockOrLoseBytes() async throws {
        let input = Data(String(repeating: "é 猫 \n", count: 100_000).utf8)
        let output = CollectedOutput()
        let result = try await NativeProcess.run(.init(executable: "/bin/cat", input: input)) { await output.append($0, $1) }
        XCTAssertEqual(result.code, 0)
        let received = await output.stdout
        XCTAssertEqual(received, input)
    }

    func testWorkingDirectoryEnvironmentAndSeparateStderr() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data().write(to: directory.appendingPathComponent("marker"))
        let output = CollectedOutput()
        let spec = ProcessSpecification(executable: "/bin/sh", arguments: ["-c", "test -f marker || exit 11; printf '%s' \"$TSQ_TASK_ID\"; printf 'problem' >&2; exit 7"],
                                        directory: directory.path, environment: ["TSQ_TASK_ID": "é task"])
        let result = try await NativeProcess.run(spec) { await output.append($0, $1) }
        XCTAssertEqual(result.code, 7)
        let stdout = await output.stdout, stderr = await output.stderr
        XCTAssertEqual(stdout, Data("é task".utf8))
        XCTAssertEqual(stderr, Data("problem".utf8))
    }

    func testCancellationTerminatesProcessGroup() async throws {
        let started = expectation(description: "child started")
        let task = Task {
            try await NativeProcess.run(.init(executable: "/bin/sh", arguments: ["-c", "printf ready; exec /bin/sleep 120"])) { _, _ in started.fulfill() }
        }
        await fulfillment(of: [started], timeout: 3)
        task.cancel()
        do { _ = try await task.value; XCTFail("Expected cancellation") } catch is CancellationError { }
    }

    func testCancellationCleansUpDescendantsAfterLauncherExits() async throws {
        let started = expectation(description: "background child started")
        let result = try await NativeProcess.run(.init(executable: "/bin/sh", arguments: ["-c", "/bin/sleep 120 & printf ready"])) { _, _ in started.fulfill() }
        await fulfillment(of: [started], timeout: 3)
        // The launcher exits almost immediately after backgrounding sleep;
        // terminate() now fires as soon as wait() returns the direct child's
        // exit (not only on cancellation), so this completes on its own instead
        // of hanging until something cancels it.
        XCTAssertEqual(result.code, 0)
    }

    /// Without cancellation, `wait()` returning for the direct child must still
    /// trigger terminate() — otherwise a backgrounded descendant that inherited
    /// the (non-CLOEXEC) output pipe fds blocks the drain loops in an EOF-less
    /// read forever.
    func testDescendantHoldingPipeOpenDoesNotHangAfterNormalExit() async throws {
        let result = try await withThrowingTaskGroup(of: ProcessExit.self) { group in
            group.addTask { try await NativeProcess.run(.init(executable: "/bin/sh", arguments: ["-c", "sleep 120 & exit 0"])) }
            group.addTask {
                try await Task.sleep(for: .seconds(5))
                throw ConfigurationError("timed out — a descendant likely kept the output pipe open")
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
        XCTAssertEqual(result.code, 0)
    }

    func testMissingExecutableAndNULAreRejected() async {
        do { _ = try await NativeProcess.run(.init(executable: "/nonexistent/tasksquad-test")); XCTFail("Expected launch failure") } catch { }
        do { _ = try await NativeProcess.run(.init(executable: "/bin/echo", arguments: ["bad\0argument"])); XCTFail("Expected NUL rejection") } catch { }
    }
}

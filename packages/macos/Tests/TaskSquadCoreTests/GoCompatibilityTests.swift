import XCTest
@testable import TaskSquadCore

final class GoCompatibilityTests: XCTestCase {
    private func oracle() throws -> URL {
        guard let path = ProcessInfo.processInfo.environment["TSQ_GO_ORACLE"] else {
            throw XCTSkip("Use make test-compatibility to build the Go reference executable")
        }
        return URL(fileURLWithPath: path)
    }
    private func run(_ arguments: [String]) throws -> (Int32, Data) {
        let process = Process()
        process.executableURL = try oracle()
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, data)
    }

    func testConfigurationAgainstCurrentGoImplementation() throws {
        _ = try oracle()
        let fixtures = Bundle.module.url(forResource: "Fixtures", withExtension: nil)!
        let files = try FileManager.default.contentsOfDirectory(at: fixtures, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "toml" }
        XCTAssertGreaterThanOrEqual(files.count, 4)
        for file in files {
            let (status, output) = try run(["config", file.path])
            if file.lastPathComponent.hasPrefix("invalid-") {
                XCTAssertNotEqual(status, 0, file.lastPathComponent)
                XCTAssertThrowsError(try DaemonConfiguration.load(from: file), file.lastPathComponent)
            } else {
                XCTAssertEqual(status, 0, file.lastPathComponent)
                let expected = try JSONDecoder().decode(DaemonConfiguration.self, from: output)
                XCTAssertEqual(try DaemonConfiguration.load(from: file), expected, file.lastPathComponent)
            }
        }
    }

    func testGoAndSwiftDecryptEachOthersPayloads() throws {
        _ = try oracle()
        let plaintext = "transcript\nUnicode é猫 with spaces  "
        for size in [16, 24, 32] {
            let key = Data(repeating: 42, count: size).base64EncodedString()
            // Foundation Process may normalize Unicode arguments; transport exact bytes.
            let (status, encrypted) = try run(["encrypt", key, Data(plaintext.utf8).base64EncodedString()])
            XCTAssertEqual(status, 0)
            let data = try XCTUnwrap(Data(base64Encoded: String(decoding: encrypted, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)))
            XCTAssertEqual(try PayloadEncryption.decrypt(data, key: key), Data(plaintext.utf8))
            let swift = try PayloadEncryption.encrypt(Data(plaintext.utf8), key: key)
            let (decryptStatus, decrypted) = try run(["decrypt", key, swift.base64EncodedString()])
            XCTAssertEqual(decryptStatus, 0)
            XCTAssertEqual(decrypted, Data(plaintext.utf8))
        }
    }

    func testGoAndSwiftMutuallyExcludeDaemonStartup() throws {
        let executable = try oracle()
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let paths = TaskSquadPaths(home: home)
        defer { try? FileManager.default.removeItem(at: home) }
        let process = Process()
        process.executableURL = executable
        process.arguments = ["lock", paths.root.path]
        let input = Pipe(), output = Pipe()
        process.standardInput = input; process.standardOutput = output
        try process.run()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        XCTAssertEqual(output.fileHandleForReading.readData(ofLength: 7), Data("locked\n".utf8))
        XCTAssertThrowsError(try DaemonLock(paths: paths))
        try input.fileHandleForWriting.close()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        let lock = try DaemonLock(paths: paths)
        let (status, _) = try run(["lock", paths.root.path])
        XCTAssertNotEqual(status, 0)
        withExtendedLifetime(lock) { }
    }
}

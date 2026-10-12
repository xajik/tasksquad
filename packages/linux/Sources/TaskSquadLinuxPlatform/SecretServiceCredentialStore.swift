import Foundation
import TaskSquadCore

/// The freedesktop Secret Service (GNOME Keyring, KWallet) through `secret-tool`,
/// with go-keyring's item layout: attributes {service, username}, label
/// "Password for '<user>' on '<service>'", plain-text secret. Go and Swift read
/// each other's items. Like go-keyring there is no file fallback: without a
/// running Secret Service (headless servers) every call fails.
public struct SecretServiceCredentialStore: CredentialStore {
    static let tool = "secret-tool"
    private let service: String
    private let environment: [String: String]

    public init(service: String = CredentialService.daemon, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.service = service; self.environment = environment
    }

    public func read(_ key: CredentialKey) throws -> String? {
        let result = try run(["lookup", "service", service, "username", key.rawValue])
        if result.status == 0 { return String(decoding: result.stdout, as: UTF8.self) }
        // secret-tool exits 1 with no output when nothing matches; errors go to stderr.
        let message = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if message.isEmpty { return nil }
        throw CredentialError.keychain(message)
    }

    /// go-keyring Set: the secret goes over stdin, never argv.
    public func write(_ value: String, for key: CredentialKey) throws {
        let label = "Password for '\(key.rawValue)' on '\(service)'"
        let result = try run(["store", "--label=\(label)", "service", service, "username", key.rawValue], input: Data(value.utf8))
        guard result.status == 0 else { throw CredentialError.keychain(result.stderr) }
    }

    public func delete(_ key: CredentialKey) throws {
        let result = try run(["clear", "service", service, "username", key.rawValue])
        let message = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        guard result.status == 0 || message.isEmpty else { throw CredentialError.keychain(message) }
    }

    private func run(_ arguments: [String], input: Data? = nil) throws -> (status: Int32, stdout: Data, stderr: String) {
        guard let executable = ExecutableLocator.find(Self.tool, environment: environment) else {
            throw CredentialError.keychain("secret-tool not found: install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora)")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.environment = environment
        let stdout = Pipe(), stderr = Pipe(), stdin = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = stdin
        try process.run()
        if let input { try? stdin.fileHandleForWriting.write(contentsOf: input) }
        try? stdin.fileHandleForWriting.close()
        // Drain stderr concurrently so a chatty failure can't fill its pipe and deadlock.
        final class Box: @unchecked Sendable { var data = Data() }
        let errors = Box(), done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { errors.data = stderr.fileHandleForReading.readDataToEndOfFile(); done.signal() }
        let output = stdout.fileHandleForReading.readDataToEndOfFile()
        done.wait()
        process.waitUntilExit()
        return (process.terminationStatus, output, String(decoding: errors.data, as: UTF8.self))
    }
}

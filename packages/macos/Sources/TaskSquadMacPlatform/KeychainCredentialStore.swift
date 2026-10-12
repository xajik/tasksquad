import Foundation
import TaskSquadCore

/// Login Keychain through /usr/bin/security, exactly like go-keyring on macOS,
/// so both daemons read each other's values without an authorization prompt.
public struct KeychainCredentialStore: CredentialStore {
    public static let service = CredentialService.daemon
    static let tool = "/usr/bin/security"
    private let service: String
    public init(service: String = Self.service) { self.service = service }

    public func read(_ key: CredentialKey) throws -> String? {
        let result = try Self.run(["find-generic-password", "-s", service, "-wa", key.rawValue])
        if result.output.contains("could not be found") { return nil }
        guard result.status == 0 else { throw CredentialError.keychain(result.output) }
        return try Self.decode(Data(result.output.utf8))
    }

    /// Same as read: items trusting /usr/bin/security never prompt.
    public func readWithoutPrompt(_ key: CredentialKey) throws -> String? { try read(key) }

    /// go-keyring's Set: the command goes over `security -i` stdin so the secret is never in argv.
    public func write(_ value: String, for key: CredentialKey) throws {
        let password = String(decoding: Self.encode(value), as: UTF8.self)
        let command = "add-generic-password -U -s \(Self.shellQuote(service)) -a \(Self.shellQuote(key.rawValue)) -w \(Self.shellQuote(password))\n"
        guard command.utf8.count <= 4096 else { throw CredentialError.keychain("data passed to Set was too big") }
        let result = try Self.run(["-i"], input: command)
        guard result.status == 0 else { throw CredentialError.keychain(result.output) }
    }

    public func delete(_ key: CredentialKey) throws {
        let result = try Self.run(["delete-generic-password", "-s", service, "-a", key.rawValue])
        guard result.status == 0 || result.output.contains("could not be found") else { throw CredentialError.keychain(result.output) }
    }

    /// Go's exec.Command(...).CombinedOutput(): stdout and stderr together.
    private static func run(_ arguments: [String], input: String? = nil) throws -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        let output = Pipe(), stdin = Pipe()
        process.standardOutput = output
        process.standardError = output
        process.standardInput = stdin
        try process.run()
        if let input { stdin.fileHandleForWriting.write(Data(input.utf8)) }
        try stdin.fileHandleForWriting.close()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: data, as: UTF8.self))
    }

    /// al.essio.dev/pkg/shellescape Quote, which go-keyring uses for `security -i`.
    static func shellQuote(_ value: String) -> String {
        if value.isEmpty { return "''" }
        let safe = value.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII || "_@%+=:,./-".unicodeScalars.contains(scalar)
        }
        return safe ? value : "'" + value.replacingOccurrences(of: "'", with: #"'"'"'"#) + "'"
    }

    static func encode(_ value: String) -> Data { Data(("go-keyring-base64:" + Data(value.utf8).base64EncodedString()).utf8) }
    static func decode(_ data: Data) throws -> String {
        guard let raw = String(data: data, encoding: .utf8) else { throw CredentialError.invalidEncoding }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("go-keyring-base64:") {
            guard let decoded = Data(base64Encoded: String(value.dropFirst("go-keyring-base64:".count))),
                  let result = String(data: decoded, encoding: .utf8) else { throw CredentialError.invalidEncoding }
            return result
        }
        if value.hasPrefix("go-keyring-encoded:") {
            let hex = Array(value.dropFirst("go-keyring-encoded:".count))
            guard hex.count.isMultiple(of: 2) else { throw CredentialError.invalidEncoding }
            var bytes: [UInt8] = []
            for index in stride(from: 0, to: hex.count, by: 2) {
                guard let byte = UInt8(String(hex[index...index + 1]), radix: 16) else { throw CredentialError.invalidEncoding }
                bytes.append(byte)
            }
            guard let result = String(bytes: bytes, encoding: .utf8) else { throw CredentialError.invalidEncoding }
            return result
        }
        return value
    }
}

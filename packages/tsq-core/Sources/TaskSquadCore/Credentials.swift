import Foundation

public enum CredentialKey: String, CaseIterable, Sendable {
    case idToken = "id-token", refreshToken = "refresh-token", expiry, email
    case cliToken = "cli-token", cliTokenExpiry = "cli-token-expiry"
}

/// The secret-store service both daemons use (Go: auth.keychainService).
public enum CredentialService {
    public static let daemon = "tasksquad-daemon"
}

public protocol CredentialStore: Sendable {
    func read(_ key: CredentialKey) throws -> String?
    func write(_ value: String, for key: CredentialKey) throws
    func delete(_ key: CredentialKey) throws
}

/// The login Keychain through /usr/bin/security, exactly as Go's go-keyring does.
/// Items either daemon creates then trust the same tool, so neither daemon (nor a
/// rebuilt, differently-signed Swift binary) triggers a macOS authorization prompt.
public enum CredentialError: LocalizedError {
    case invalidEncoding, keychain(String), notLoggedIn
    public var errorDescription: String? {
        switch self {
        case .invalidEncoding: "Invalid Keychain credential encoding"
        case .keychain(let message): "Keychain: \(message.trimmingCharacters(in: .whitespacesAndNewlines))"
        case .notLoggedIn: "Not logged in — run: tsq login"
        }
    }
}

import Foundation
import Security

public enum CredentialKey: String, CaseIterable, Sendable {
    case idToken = "id-token", refreshToken = "refresh-token", expiry, email
    case cliToken = "cli-token", cliTokenExpiry = "cli-token-expiry"
}

public protocol CredentialStore: Sendable {
    func read(_ key: CredentialKey) throws -> String?
    func write(_ value: String, for key: CredentialKey) throws
    func delete(_ key: CredentialKey) throws
}

public struct KeychainCredentialStore: CredentialStore {
    public static let service = "tasksquad-daemon"
    private let service: String
    public init(service: String = Self.service) { self.service = service }

    private func query(_ key: CredentialKey) -> [String: Any] {
        // Go uses the traditional login keychain via security(1), not the
        // data-protection keychain. Do not add kSecUseDataProtectionKeychain.
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: key.rawValue]
    }

    public func read(_ key: CredentialKey) throws -> String? { try read(key, allowInteraction: true) }

    public func readWithoutPrompt(_ key: CredentialKey) throws -> String? { try read(key, allowInteraction: false) }

    private func read(_ key: CredentialKey, allowInteraction: Bool) throws -> String? {
        var query = query(key)
        if !allowInteraction { query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status)
        guard let data = result as? Data else { throw CredentialError.invalidEncoding }
        return try Self.decode(data)
    }

    public func write(_ value: String, for key: CredentialKey) throws {
        let data = Self.encode(value)
        let query = query(key)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var attributes = query
            attributes[kSecValueData as String] = data
            // Go's keyring adapter reads these through Apple's security executable.
            // Trust only this application and that system tool for newly created items.
            var currentApp: SecTrustedApplication?
            var securityTool: SecTrustedApplication?
            try check(SecTrustedApplicationCreateFromPath(nil, &currentApp))
            try check(SecTrustedApplicationCreateFromPath("/usr/bin/security", &securityTool))
            if let currentApp, let securityTool {
                var access: SecAccess?
                try check(SecAccessCreate("TaskSquad credentials" as CFString, [currentApp, securityTool] as CFArray, &access))
                attributes[kSecAttrAccess as String] = access
            }
            try check(SecItemAdd(attributes as CFDictionary, nil))
        } else { try check(status) }
    }

    public func delete(_ key: CredentialKey) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }

    // Match go-keyring v0.2.6, including its historical hex representation.
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

    private func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else { throw CredentialError.keychain(status) }
    }
}

public enum CredentialError: LocalizedError {
    case invalidEncoding, keychain(OSStatus), notLoggedIn
    public var errorDescription: String? {
        switch self {
        case .invalidEncoding: "Invalid Keychain credential encoding"
        case .keychain(let status): "Keychain: \(SecCopyErrorMessageString(status, nil) as String? ?? String(status))"
        case .notLoggedIn: "Not logged in — run: tsq login"
        }
    }
}

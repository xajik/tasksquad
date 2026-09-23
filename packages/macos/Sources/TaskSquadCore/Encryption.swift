import Foundation
import CryptoKit

public enum PayloadEncryption {
    /// Go's nonce || ciphertext || tag is CryptoKit's combined representation.
    public static func encrypt(_ data: Data, key base64: String) throws -> Data {
        let key = try key(base64)
        let sealed = try AES.GCM.seal(data, using: key)
        guard let combined = sealed.combined else { throw ConfigurationError("Missing AES-GCM representation") }
        return combined
    }
    public static func decrypt(_ data: Data, key base64: String) throws -> Data {
        try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key(base64))
    }
    private static func key(_ base64: String) throws -> SymmetricKey {
        guard let raw = Data(base64Encoded: base64), [16, 24, 32].contains(raw.count)
        else { throw ConfigurationError("Invalid DEK: expected a base64 AES key") }
        return SymmetricKey(data: raw)
    }
}

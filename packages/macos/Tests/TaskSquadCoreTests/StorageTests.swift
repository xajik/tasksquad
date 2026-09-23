import XCTest
import Darwin
@testable import TaskSquadCore

final class StorageTests: XCTestCase {
    func testCredentialFormats() throws {
        XCTAssertEqual(try KeychainCredentialStore.decode(Data("go-keyring-base64:dHNxX3Rva2Vu".utf8)), "tsq_token")
        XCTAssertEqual(try KeychainCredentialStore.decode(Data("go-keyring-encoded:7473715f746f6b656e".utf8)), "tsq_token")
        XCTAssertEqual(try KeychainCredentialStore.decode(Data("  legacy-token\n".utf8)), "legacy-token")
        let secret = "unicode é\ntrailing whitespace  "
        XCTAssertEqual(try KeychainCredentialStore.decode(KeychainCredentialStore.encode(secret)), secret)
        XCTAssertThrowsError(try KeychainCredentialStore.decode(Data("go-keyring-base64:!!!".utf8)))
        XCTAssertThrowsError(try KeychainCredentialStore.decode(Data("go-keyring-encoded:bad".utf8)))
    }

    func testDeviceIdentityAndSharedLockInode() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let paths = TaskSquadPaths(home: home)
        defer { try? FileManager.default.removeItem(at: home) }
        let id = try paths.deviceID()
        XCTAssertNotNil(UUID(uuidString: id))
        XCTAssertEqual(try paths.deviceID(), id)
        let attributes = try FileManager.default.attributesOfItem(atPath: paths.root.appendingPathComponent("device-id").path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        var lock: DaemonLock? = try DaemonLock(paths: paths)
        XCTAssertNotNil(lock)
        XCTAssertThrowsError(try DaemonLock(paths: paths))
        let inode = try FileManager.default.attributesOfItem(atPath: paths.lock.path)[.systemFileNumber] as? NSNumber
        lock = nil
        let reacquired = try DaemonLock(paths: paths)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: paths.lock.path)[.systemFileNumber] as? NSNumber, inode)
        withExtendedLifetime(reacquired) { }
    }

    func testFinderPathOrderAndDeduplication() {
        let paths = TaskSquadPaths(home: URL(fileURLWithPath: "/Users/test"))
        let value = paths.searchPath(executable: "/Applications/TaskSquad.app/Contents/MacOS/TaskSquad",
                                    inherited: "/custom/bin:/usr/bin:relative::/custom/bin")
        let entries = value.components(separatedBy: ":")
        XCTAssertEqual(Array(entries.prefix(3)), ["/Applications/TaskSquad.app/Contents/MacOS", "/custom/bin", "/usr/bin"])
        XCTAssertEqual(Set(entries).count, entries.count)
        XCTAssertTrue(entries.contains("/Users/test/.bun/bin"))
        XCTAssertFalse(entries.contains("relative"))
        XCTAssertFalse(entries.contains(""))
    }

    func testAESGCMNonceLayoutAndTamperRejection() throws {
        let key = Data(repeating: 7, count: 32).base64EncodedString()
        let plaintext = Data("task transcript\nwith unicode 🐈".utf8)
        let combined = try PayloadEncryption.encrypt(plaintext, key: key)
        XCTAssertEqual(combined.count, plaintext.count + 12 + 16)
        XCTAssertEqual(try PayloadEncryption.decrypt(combined, key: key), plaintext)
        var tampered = combined
        tampered[tampered.count - 1] ^= 1
        XCTAssertThrowsError(try PayloadEncryption.decrypt(tampered, key: key))
        XCTAssertThrowsError(try PayloadEncryption.encrypt(plaintext, key: "bad"))
    }
}

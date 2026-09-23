import Foundation
import Darwin

public struct TaskSquadPaths: Sendable {
    public let home: URL
    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.home = home
    }
    public var root: URL { home.appendingPathComponent(".tasksquad", isDirectory: true) }
    public var config: URL { root.appendingPathComponent("config.toml") }
    public var logs: URL { root.appendingPathComponent("logs", isDirectory: true) }
    public var tasks: URL { root.appendingPathComponent("tasks", isDirectory: true) }
    public var lock: URL { root.appendingPathComponent("daemon.lock") }

    public func createRoot() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
    }

    public func deviceID() throws -> String {
        let url = root.appendingPathComponent("device-id")
        if let value = try? String(contentsOf: url, encoding: .utf8) {
            return value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        try createRoot()
        let value = UUID().uuidString.lowercased()
        // O_EXCL prevents two first launches from replacing one another's identity.
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else {
            if errno == EEXIST {
                return try String(contentsOf: url, encoding: .utf8)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try handle.write(contentsOf: Data(value.utf8))
        try handle.close()
        return value
    }

    public func expandHome(_ path: String) -> String {
        guard path.hasPrefix("~/") else { return path }
        return home.appendingPathComponent(String(path.dropFirst(2))).standardizedFileURL.path
    }

    public func searchPath(executable: String, inherited: String) -> String {
        let candidates = [URL(fileURLWithPath: executable).deletingLastPathComponent().path]
            + inherited.components(separatedBy: ":")
            + ["/opt/homebrew/bin", "/usr/local/bin", home.path + "/.local/bin",
               home.path + "/.bun/bin", home.path + "/.cargo/bin",
               "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        var seen = Set<String>()
        return candidates.filter { $0.hasPrefix("/") && seen.insert($0).inserted }.joined(separator: ":")
    }
}

/// Uses the same inode and BSD flock protocol as app_darwin.go. Never unlink this file.
public final class DaemonLock {
    private let descriptor: Int32
    public init(paths: TaskSquadPaths) throws {
        try paths.createRoot()
        let fd = open(paths.lock.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            close(fd)
            throw LockError.unavailable(code)
        }
        descriptor = fd
    }
    deinit { close(descriptor) }

    public enum LockError: LocalizedError {
        case unavailable(Int32)
        public var errorDescription: String? {
            "TaskSquad is already running, or its daemon lock is unavailable. Quit the running app or CLI daemon before starting another."
        }
    }
}

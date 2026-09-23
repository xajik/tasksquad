import Foundation
import Darwin

/// File handles are confined to this actor; lifecycle events append to existing
/// task journals while each run log is truncated just as in the Go daemon.
public actor RunArtifacts {
    public nonisolated let logURL: URL
    public nonisolated let journalURL: URL
    private let runLog: FileHandle
    private let journal: FileHandle
    private var closed = false

    public init(paths: TaskSquadPaths, agentName: String, taskID: String) throws {
        guard !taskID.isEmpty, !taskID.contains("/"), !taskID.contains("\\"), taskID != ".", taskID != ".." else {
            throw ConfigurationError("Invalid task ID for run artifacts")
        }
        let folder = paths.logs.appendingPathComponent(Self.sanitize(agentName), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: paths.tasks, withIntermediateDirectories: true)
        logURL = folder.appendingPathComponent(taskID + ".log")
        journalURL = paths.tasks.appendingPathComponent(taskID + ".jsonl")
        let logFD = open(logURL.path, O_CREAT | O_WRONLY | O_TRUNC | O_CLOEXEC, 0o644)
        guard logFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        runLog = FileHandle(fileDescriptor: logFD, closeOnDealloc: true)
        let journalFD = open(journalURL.path, O_CREAT | O_WRONLY | O_APPEND | O_CLOEXEC, 0o644)
        guard journalFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        journal = FileHandle(fileDescriptor: journalFD, closeOnDealloc: true)
    }

    public static func sanitize(_ name: String) -> String {
        String(String.UnicodeScalarView(name.unicodeScalars.map { scalar in
            if (65...90).contains(scalar.value) || (97...122).contains(scalar.value)
                || (48...57).contains(scalar.value) || scalar == "-" || scalar == "_" { return scalar }
            return "-"
        }))
    }

    public func writeLines(_ lines: [String]) throws {
        guard !closed, !lines.isEmpty else { return }
        try runLog.write(contentsOf: Data((lines.joined(separator: "\n") + "\n").utf8))
    }

    public func event(_ object: [String: JSONValue]) throws {
        guard !closed else { return }
        var fields = object
        fields["ts"] = .string(ISO8601DateFormatter().string(from: Date()))
        var data = try JSONEncoder().encode(JSONValue.object(fields))
        data.append(10)
        try journal.write(contentsOf: data)
    }

    public func close() throws {
        guard !closed else { return }
        closed = true
        try journal.synchronize()
        try journal.close()
        try runLog.close()
    }
}

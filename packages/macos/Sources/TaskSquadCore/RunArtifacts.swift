import Foundation
import Darwin

/// File handles are confined to this actor; lifecycle events append to existing
/// task journals while each run log is truncated just as in the Go daemon.
/// Go's time formats, so files either daemon writes parse in the other.
public enum GoTime {
    /// time.RFC3339 in local time, e.g. 2026-10-11T22:10:00+08:00 (Z in UTC).
    /// ISO8601FormatStyle writes +0800, which Go's RFC3339 parser rejects.
    public static func rfc3339(_ date: Date, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssXXXXX"
        return formatter.string(from: date)
    }
}

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

    /// Go's writeRunLog: one line prefixed with the RFC3339 time.
    public func writeTimestamped(_ message: String) throws {
        try writeLines(["\(GoTime.rfc3339(Date())) \(message)"])
    }

    /// Go's closing lines: a blank line, the outcome event and `# ended=`.
    public func writeEnd(_ event: String) throws {
        try writeLines(["", event, "# ended=\(GoTime.rfc3339(Date()))"])
    }

    /// One journal line exactly as Go's tasklog writes it: fields in struct order, `ts`
    /// (local RFC3339) last, `omitEmpty` fields dropped when "", encoding/json escaping.
    public func event(_ fields: KeyValuePairs<String, String>, omitEmpty: Set<String> = []) throws {
        guard !closed else { return }
        var parts = fields.filter { !(omitEmpty.contains($0.key) && $0.value.isEmpty) }.map { "\(Self.goQuote($0.key)):\(Self.goQuote($0.value))" }
        parts.append("\"ts\":\(Self.goQuote(GoTime.rfc3339(Date())))")
        try journal.write(contentsOf: Data(("{" + parts.joined(separator: ",") + "}\n").utf8))
    }

    /// encoding/json string quoting (HTML-safe: <, >, & as \u003c…).
    static func goQuote(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "<": out += "\\u003c"
            case ">": out += "\\u003e"
            case "&": out += "\\u0026"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) } else { out.unicodeScalars.append(scalar) }
            }
        }
        return out + "\""
    }

    public func close() throws {
        guard !closed else { return }
        closed = true
        try journal.synchronize()
        try journal.close()
        try runLog.close()
    }
}

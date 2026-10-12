import Foundation

public struct TaskHistoryEntry: Identifiable, Sendable, Equatable {
    public enum Kind: String, CaseIterable, Sendable { case task = "Task", supervisor = "Supervisor", dreamer = "Dreamer" }
    public var id: URL { url }
    public let url: URL
    public let kind: Kind
    public let taskID: String
    public let title: String
    public let agent: String
    public let agentID: String
    public let project: String
    public let projectFromConfiguration: Bool
    public let modified: Date

    public func matches(_ query: String) -> Bool {
        let fields = [title, taskID, agent, agentID, project, kind.rawValue]
        return query.split(whereSeparator: \.isWhitespace).allSatisfy { term in
            fields.contains { $0.localizedCaseInsensitiveContains(term) }
        }
    }
}

/// Reads local run metadata, including background runs which have no task journal.
/// Cache bounded header reads, but re-resolve configuration on each refresh.
public actor TaskHistoryIndex {
    private struct Header {
        var taskID = "", title = "", agent = "", agentID = "", project = ""
    }
    private struct Cached { let modified: Date; let size: Int; let header: Header }
    private var cache: [URL: Cached] = [:]
    public init() {}

    public func load(paths: TaskSquadPaths, agents: [DaemonConfiguration.Agent]) -> [TaskHistoryEntry] {
        var records: [(URL, TaskHistoryEntry.Kind, Date, Header)] = []
        let roots: [(URL, TaskHistoryEntry.Kind, String)] = [
            (paths.tasks, .task, "jsonl"),
            (paths.logs.appendingPathComponent("supervisor"), .supervisor, "log"),
            (paths.logs.appendingPathComponent("dreamer"), .dreamer, "log")
        ]
        var seen = Set<URL>()
        for (root, kind, ext) in roots {
            let urls = (try? FileManager.default.contentsOfDirectory(at: root,
                includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey], options: .skipsHiddenFiles)) ?? []
            for url in urls where url.pathExtension.lowercased() == ext {
                guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]), values.isRegularFile == true else { continue }
                let modified = values.contentModificationDate ?? .distantPast, size = values.fileSize ?? 0
                seen.insert(url)
                let header: Header
                if let saved = cache[url], saved.modified == modified, saved.size == size { header = saved.header }
                else {
                    header = Self.readHeader(url, kind: kind)
                    cache[url] = Cached(modified: modified, size: size, header: header)
                }
                records.append((url, kind, modified, header))
            }
        }
        cache = cache.filter { seen.contains($0.key) }
        let tasks = Dictionary(records.filter { $0.1 == .task }.map { ($0.0.deletingPathExtension().lastPathComponent, $0.3) }, uniquingKeysWith: { first, _ in first })
        return records.map { url, kind, modified, header in
            let taskID = header.taskID.isEmpty ? url.deletingPathExtension().lastPathComponent : header.taskID
            var info = header
            if kind == .supervisor, let task = tasks[taskID] {
                if info.agent.isEmpty { info.agent = task.agent }
                info.agentID = task.agentID
                if info.project.isEmpty { info.project = task.project }
                if info.title.isEmpty { info.title = task.title }
            }
            // IDs are authoritative. Names alone can be shared by multiple projects.
            let candidates = agents.filter { info.agentID.isEmpty ? $0.name == info.agent : $0.id == info.agentID }
            let configured = candidates.count == 1 ? candidates.first : nil
            if info.agent.isEmpty { info.agent = configured?.name ?? "" }
            let inferred = info.project.isEmpty && !(configured?.workDir.isEmpty ?? true)
            let project = paths.expandHome(info.project.isEmpty ? configured?.workDir ?? "" : info.project)
            let title = info.title.isEmpty ? (kind == .task ? taskID : "\(kind.rawValue) · \(taskID)") : info.title
            return TaskHistoryEntry(url: url, kind: kind, taskID: taskID, title: title,
                agent: info.agent, agentID: info.agentID, project: project,
                projectFromConfiguration: inferred, modified: modified)
        }.sorted { $0.modified == $1.modified ? $0.url.path < $1.url.path : $0.modified > $1.modified }
    }

    private static func readHeader(_ url: URL, kind: TaskHistoryEntry.Kind) -> Header {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return Header() }
        defer { try? handle.close() }
        let data = (try? handle.read(upToCount: 256 * 1024)) ?? Data()
        let lines = String(decoding: data, as: UTF8.self).split(separator: "\n")
        if kind == .task {
            for line in lines {
                guard let event = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], event["type"] as? String == "task_start" else { continue }
                return Header(taskID: event["task_id"] as? String ?? "", title: event["subject"] as? String ?? "",
                    agent: event["agent"] as? String ?? "", agentID: event["agent_id"] as? String ?? "", project: event["work_dir"] as? String ?? "")
            }
        } else {
            // Only inspect the generated header, never CLI output or user prose.
            for line in lines.prefix(4) {
                if line.hasPrefix("# agent="), let separator = line.range(of: "  task_id=") {
                    return Header(taskID: String(line[separator.upperBound...]), agent: String(line.dropFirst(8)[..<separator.lowerBound]))
                }
                if line.hasPrefix("# session="), let separator = line.range(of: "  work_dir=") {
                    return Header(project: String(line[separator.upperBound...]))
                }
            }
        }
        return Header()
    }
}

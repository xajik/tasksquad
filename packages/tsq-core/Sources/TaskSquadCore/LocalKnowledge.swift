import Foundation

/// A local memory (.tsq/memory) or knowledge-base (tsq/kb) search hit.
public struct KnowledgeEntry: Equatable, Sendable {
    public var scope = "", category = "", title = "", path = "", excerpt = ""
    public var tags: [String] = []
    public init(scope: String = "", category: String = "", title: String = "", path: String = "", excerpt: String = "", tags: [String] = []) {
        self.scope = scope; self.category = category; self.title = title; self.path = path; self.excerpt = excerpt; self.tags = tags
    }
}

/// Port of packages/daemon/{memory,kb}: plain-file storage and search shared by
/// `tsq memory` and `tsq kb`. Excerpts are cut on bytes exactly like Go.
public enum LocalKnowledge {
    public static let categories = ["personal", "preferences", "structure", "architecture", "events"]
    static let excerptRadius = 80

    public static func splitTags(_ value: String) -> [String] {
        value.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Go strings.TrimSpace (ASCII + Unicode spaces).
    private static func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// title, category, tags, body (body is the whole text when there is no frontmatter).
    static func frontmatter(_ raw: String) -> (title: String, category: String, tags: [String], body: String) {
        let lines = raw.components(separatedBy: "\n")
        guard let first = lines.first, trim(first) == "---", let end = lines.indices.dropFirst().first(where: { trim(lines[$0]) == "---" }) else {
            return ("", "", [], raw)
        }
        var title = "", category = "", tags: [String] = []
        for line in lines[1..<end] {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = trim(String(line[..<colon])), value = trim(String(line[line.index(after: colon)...]))
            switch key {
            case "title": title = value
            case "category": category = value
            case "tags": tags = splitTags(value)
            default: break
            }
        }
        return (title, category, tags, trim(lines[(end + 1)...].joined(separator: "\n")))
    }

    /// Byte-offset snippet around the first match: Go finds the query in the lowercased
    /// body and slices the original body at that byte offset (Go: excerpt).
    static func excerpt(_ text: String, query q: String) -> String {
        let trimmed = trim(text)
        let body = Array(trimmed.utf8)
        func string(_ bytes: ArraySlice<UInt8>) -> String { trim(String(decoding: bytes, as: UTF8.self)) }
        let needle = Array(q.utf8), lowered = Array(trimmed.lowercased().utf8)
        if !needle.isEmpty, lowered.count >= needle.count,
           let idx = (0...(lowered.count - needle.count)).first(where: { lowered[$0..<($0 + needle.count)].elementsEqual(needle) }) {
            let start = min(max(idx - excerptRadius, 0), body.count), end = min(idx + needle.count + excerptRadius, body.count)
            var snippet = start < end ? string(body[start..<end]) : ""
            if start > 0 { snippet = "…" + snippet }
            if end < body.count { snippet += "…" }
            return snippet
        }
        if body.count > 2 * excerptRadius { return string(body[..<(2 * excerptRadius)]) + "…" }
        return trimmed
    }

    private static func markdownFiles(under root: URL) -> [URL] {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { return [] }
        return enumerator.compactMap { $0 as? URL }.filter {
            $0.pathExtension == "md" && (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        }
    }

    /// Go keeps the path as filepath.Join built it (the work dir as given, no symlink resolution).
    private static func joined(_ root: String, _ file: URL, base: URL) -> String {
        let relative = file.standardizedFileURL.path.dropFirst(base.standardizedFileURL.path.count)
        return root + relative
    }

    public static func searchMemory(workDir: String, query: String) -> [KnowledgeEntry] {
        let rootPath = (workDir as NSString).appendingPathComponent(".tsq/memory")
        let root = URL(fileURLWithPath: rootPath)
        let q = trim(query).lowercased()
        var entries: [KnowledgeEntry] = []
        for file in markdownFiles(under: root) {
            guard let raw = try? String(contentsOf: file, encoding: .utf8) else { continue }
            let path = joined(rootPath, file, base: root)
            var (title, category, tags, body) = frontmatter(raw)
            if category.isEmpty {
                let parts = path.dropFirst(rootPath.count + 1).split(separator: "/")
                if parts.count > 1 { category = String(parts[0]) }
            }
            guard q.isEmpty || (title + " " + tags.joined(separator: " ") + " " + body).lowercased().contains(q) else { continue }
            entries.append(KnowledgeEntry(scope: "local", category: category, title: title, path: path, excerpt: excerpt(body, query: q), tags: tags))
        }
        return entries.sorted { Array($0.path.utf8).lexicographicallyPrecedes(Array($1.path.utf8)) }
    }

    public static func searchKB(workDir: String, query: String) -> [KnowledgeEntry] {
        let rootPath = (workDir as NSString).appendingPathComponent("tsq/kb")
        let root = URL(fileURLWithPath: rootPath)
        let q = trim(query).lowercased()
        var entries: [KnowledgeEntry] = []
        for file in markdownFiles(under: root) {
            guard let raw = try? String(contentsOf: file, encoding: .utf8) else { continue }
            var (title, _, tags, body) = frontmatter(raw)
            if title.isEmpty { title = String(file.deletingPathExtension().lastPathComponent) }
            guard q.isEmpty || (title + " " + tags.joined(separator: " ") + " " + body).lowercased().contains(q) else { continue }
            entries.append(KnowledgeEntry(title: title, path: joined(rootPath, file, base: root), excerpt: excerpt(body, query: q), tags: tags))
        }
        return entries.sorted { Array($0.path.utf8).lexicographicallyPrecedes(Array($1.path.utf8)) }
    }

    /// `.tsq/memory/<category>/<date>-<slug>[-N].md` with frontmatter (Go: memory.WriteLocal).
    public static func writeMemory(workDir: String, category: String, title: String, content: String, tags: [String], now: Date = Date(),
                                   timeZone: TimeZone = GoTime.local) throws -> String {
        let dir = (workDir as NSString).appendingPathComponent(".tsq/memory/\(category)")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let date = now.formatted(Date.ISO8601FormatStyle(timeZone: timeZone).year().month().day().dateSeparator(.dash))
        var slug = trim(title).lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
        slug = slug.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        if slug.isEmpty { slug = "untitled" }
        let base = "\(date)-\(slug)"
        var path = (dir as NSString).appendingPathComponent(base + ".md")
        var n = 2
        while FileManager.default.fileExists(atPath: path) { path = (dir as NSString).appendingPathComponent("\(base)-\(n).md"); n += 1 }
        var body = content
        while body.hasSuffix("\n") { body.removeLast() }
        let text = "---\ntitle: \(title)\ncategory: \(category)\ndate: \(date)\ntags: \(tags.joined(separator: ", "))\n---\n\n\(body)\n"
        try Data(text.utf8).write(to: URL(fileURLWithPath: path))
        return path
    }
}

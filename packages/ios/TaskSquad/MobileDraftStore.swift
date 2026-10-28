import Foundation
import CryptoKit
import TaskSquadPortal

@MainActor enum MobileDraftStore {
    private static var defaults: UserDefaults {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-api") || ProcessInfo.processInfo.arguments.contains("--ui-test-auth") { return UserDefaults(suiteName: "ai.tasksquad.fixture-drafts")! }
        #endif
        return .standard
    }
    private static var store: WorkspaceDraftStore { WorkspaceDraftStore(defaults: defaults, prefix: "mobile.draft.") }
    private static var attachments: MobileAttachmentDraftStore {
        let fixture = defaults != UserDefaults.standard
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(fixture ? "FixtureAttachmentDrafts" : "AttachmentDrafts", isDirectory: true)
        return MobileAttachmentDraftStore(root: root)
    }
    static func load(_ key: String) -> [String: JSONValue]? { store.load(key) }
    static func save(_ value: [String: JSONValue], key: String) { store.save(value, key: key) }
    static func loadFiles(_ key: String) throws -> [CustomerUpload] { try attachments.load(key) }
    static func saveFiles(_ files: [CustomerUpload], key: String) throws { try attachments.save(files, key: key) }
    static func remove(_ key: String) { store.remove(key); try? attachments.remove(key) }
    static func clear() { store.clear(); try? attachments.clear() }
}

/// A scoped manifest is committed only after all image bytes have been written.
/// Filenames come from UUIDs, never from the uploaded name or draft scope.
struct MobileAttachmentDraftStore {
    let root: URL
    private struct Entry: Codable {
        let file: String
        let name: String
        let mime: String
    }
    private func directory(_ key: String) -> URL {
        root.appendingPathComponent(SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined(), isDirectory: true)
    }
    func load(_ key: String) throws -> [CustomerUpload] {
        let folder = directory(key), manifest = folder.appendingPathComponent("images.json")
        guard FileManager.default.fileExists(atPath: manifest.path) else { return [] }
        let entries = try JSONDecoder().decode([Entry].self, from: Data(contentsOf: manifest))
        guard entries.count <= 5 else { throw CocoaError(.fileReadCorruptFile) }
        let files = try entries.map { entry in
            guard UUID(uuidString: entry.file) != nil else { throw CocoaError(.fileReadCorruptFile) }
            let url = folder.appendingPathComponent(entry.file)
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= 10 * 1024 * 1024 else { throw CocoaError(.fileReadCorruptFile) }
            return CustomerUpload(name: entry.name, mimeType: entry.mime, data: try Data(contentsOf: url))
        }
        try WorkspaceEditor.validateAttachments(files)
        return files
    }
    func save(_ files: [CustomerUpload], key: String) throws {
        try WorkspaceEditor.validateAttachments(files)
        if files.isEmpty { try remove(key); return }
        let manager = FileManager.default, folder = directory(key)
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        var excluded = root
        var resources = URLResourceValues(); resources.isExcludedFromBackup = true
        try excluded.setResourceValues(resources)
        var written: [URL] = []
        do {
            let entries = try files.map { file in
                let name = UUID().uuidString, url = folder.appendingPathComponent(name)
                try file.data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                written.append(url)
                return Entry(file: name, name: file.name, mime: file.mimeType)
            }
            try JSONEncoder().encode(entries).write(to: folder.appendingPathComponent("images.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            for url in written { try? manager.removeItem(at: url) }
            throw error
        }
        let retained = Set(written.map(\.lastPathComponent) + ["images.json"])
        for url in (try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] where !retained.contains(url.lastPathComponent) { try? manager.removeItem(at: url) }
    }
    func remove(_ key: String) throws {
        let folder = directory(key)
        if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
    }
    func clear() throws {
        if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
    }
}

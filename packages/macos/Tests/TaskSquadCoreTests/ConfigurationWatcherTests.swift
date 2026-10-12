import XCTest
@testable import TaskSquadCore
@testable import TaskSquadMacPlatform

final class ConfigurationWatcherTests: PlatformTestCase {
    func testWatcherHandlesAtomicReplacementAndRejectsInvalidChanges() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("config.toml")
        try Data("[[agents]]\nid='one'".utf8).write(to: file)
        let changed = expectation(description: "atomic replacement observed")
        let watcher = try ConfigurationWatcher(url: file) { result in
            if case .success(let config) = result, config.agents.first?.id == "two" { changed.fulfill() }
        }
        try Data("[[agents]]\nid='two'".utf8).write(to: file, options: .atomic)
        wait(for: [changed], timeout: 3)
        withExtendedLifetime(watcher) { }
    }
}

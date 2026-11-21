import AppKit
import Foundation

/// The `tsq` CLI bundled in the app, and the `~/.local/bin/tsq` link that puts it on PATH.
/// Mirrors `make install-cli`: never replaces a `tsq` that isn't a link (e.g. the Go/Homebrew one).
struct CommandLineTool {
    enum Status: Equatable {
        case notInstalled
        case installed
        case linkedElsewhere(String)
        case blocked
        case unavailable
    }

    var target: URL
    var link: URL

    init(target: URL = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/tsq"),
         link: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/tsq")) {
        self.target = target
        self.link = link
    }

    /// The equivalent shell command, shown so it can be copied and run by hand.
    var command: String {
        "mkdir -p \(Self.quoted(link.deletingLastPathComponent().path)) && ln -sfn \(Self.quoted(target.path)) \(Self.quoted(link.path))"
    }

    var status: Status {
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: target.path) else { return .unavailable }
        guard let destination = try? fm.destinationOfSymbolicLink(atPath: link.path) else {
            return fm.fileExists(atPath: link.path) ? .blocked : .notInstalled
        }
        return destination == target.path ? .installed : .linkedElsewhere(destination)
    }

    /// Creates or refreshes the link. Throws a user-readable error when it must not touch what is there.
    func install() throws {
        let fm = FileManager.default
        switch status {
        case .unavailable: throw Failure("This build of TaskSquad has no bundled tsq to link.")
        case .blocked: throw Failure("\(link.path) already exists and is not a link, so it was left alone (a Go or Homebrew tsq?).")
        case .installed: return
        case .notInstalled, .linkedElsewhere: break
        }
        try fm.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        if (try? fm.destinationOfSymbolicLink(atPath: link.path)) != nil { try fm.removeItem(at: link) }
        try fm.createSymbolicLink(at: link, withDestinationURL: target)
    }

    func copyCommand() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
    }

    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    private static func quoted(_ path: String) -> String { "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'" }
}

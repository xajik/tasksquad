import Foundation

public struct TmuxPane: Identifiable, Sendable, Hashable {
    public var id: String { sessionID + ":" + paneID }
    public let sessionID: String
    public let sessionName: String
    public let windowID: String
    public let paneID: String
    public let command: String
    public let directory: String
    public let title: String
    public let dead: Bool
    public var isAgent: Bool { sessionName.hasPrefix("tsq-") }

    public static let format = "#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{pane_dead}"
    public static func parse(_ output: String) -> [Self] {
        output.split(separator: "\n").compactMap { line in
            let fields = line.components(separatedBy: "\t")
            guard fields.count == 8, validID(fields[0], prefix: "$"), validID(fields[2], prefix: "@"), validID(fields[3], prefix: "%") else { return nil }
            return Self(sessionID: fields[0], sessionName: fields[1], windowID: fields[2], paneID: fields[3],
                        command: fields[4], directory: fields[5], title: fields[6], dead: fields[7] == "1")
        }
    }
    public static func validID(_ value: String, prefix: Character) -> Bool {
        value.first == prefix && value.count > 1 && value.dropFirst().utf8.allSatisfy { (48...57).contains($0) }
    }
}

private actor TmuxOutput {
    var data = Data()
    func append(_ chunk: Data) throws {
        guard data.count + chunk.count <= 4 * 1024 * 1024 else { throw ConfigurationError("tmux response exceeds 4 MiB") }
        data.append(chunk)
    }
}

public struct TmuxConnection: Sendable {
    public let executable: String
    public let socketPath: String?
    /// Process environment for tmux; nil inherits this process's (TMUX_TMPDIR selects the default server).
    public let environment: [String: String]?
    public init(executable: String = "tmux", socketPath: String? = nil, environment: [String: String]? = nil) {
        self.executable = executable; self.socketPath = socketPath; self.environment = environment
    }
    public var prefix: [String] { socketPath.map { ["-S", $0] } ?? [] }
    public func run(_ arguments: [String]) async throws -> String {
        let out = TmuxOutput(), err = TmuxOutput()
        var environment = self.environment ?? ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "TMUX")
        let status = try await NativeProcess.run(.init(executable: executable, arguments: prefix + arguments, environment: environment)) { channel, data in
            switch channel { case .stdout: try await out.append(data); case .stderr: try await err.append(data) }
        }
        let output = String(decoding: await out.data, as: UTF8.self)
        if status.code != 0 { throw ConfigurationError(String(decoding: await err.data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) }
        return output
    }
    public func panes() async throws -> [TmuxPane] {
        do { return TmuxPane.parse(try await run(["list-panes", "-a", "-F", TmuxPane.format])) }
        catch {
            let message = error.localizedDescription
            if message.contains("no server running") || message.contains("No such file or directory") { return [] }
            throw error
        }
    }
    public func closeSession(_ sessionID: String) async throws {
        guard TmuxPane.validID(sessionID, prefix: "$") else { throw ConfigurationError("Invalid tmux session ID") }
        _ = try await run(["kill-session", "-t", sessionID])
    }
}

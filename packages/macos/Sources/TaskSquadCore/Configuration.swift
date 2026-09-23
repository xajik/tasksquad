import Foundation
import Darwin

public struct DaemonConfiguration: Codable, Equatable, Sendable {
    public struct Server: Codable, Equatable, Sendable {
        public var url = "https://api.tasksquad.ai"
        public var pollInterval = 60
        enum CodingKeys: String, CodingKey { case url = "URL", pollInterval = "PollInterval" }
    }
    public struct Agent: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var command: String
        public var workDir: String
        public var provider: String
        enum CodingKeys: String, CodingKey {
            case id = "ID", name = "Name", command = "Command", workDir = "WorkDir", provider = "Provider"
        }
    }
    public struct Port: Codable, Equatable, Sendable {
        public var port: Int
        enum CodingKeys: String, CodingKey { case port = "Port" }
    }
    public struct Firebase: Codable, Equatable, Sendable {
        public var apiKey = ""
        public var authDomain = ""
        enum CodingKeys: String, CodingKey { case apiKey = "APIKey", authDomain = "AuthDomain" }
    }
    public struct Analytics: Codable, Equatable, Sendable {
        public var apiKey = "f9b76851c13dec7adb26c8552028913c"
        public var enabled = false
        enum CodingKeys: String, CodingKey { case apiKey = "APIKey", enabled = "Enabled" }
    }
    public struct Supervisor: Codable, Equatable, Sendable {
        public var command: String
        enum CodingKeys: String, CodingKey { case command = "Command" }
    }
    public struct Dreamer: Codable, Equatable, Sendable {
        public var command: String
        public var windowStart: String
        public var windowEnd: String
        enum CodingKeys: String, CodingKey { case command = "Command", windowStart = "WindowStart", windowEnd = "WindowEnd" }
    }

    public var server = Server()
    public var agents: [Agent] = []
    public var hooks = Port(port: 7374)
    public var ui = Port(port: 7373)
    public var firebase = Firebase()
    public var analytics = Analytics()
    public var supervisor: Supervisor?
    public var dreamer: Dreamer?
    enum CodingKeys: String, CodingKey {
        case server = "Server", agents = "Agents", hooks = "Hooks", ui = "UI", firebase = "Firebase"
        case analytics = "Analytics", supervisor = "Supervisor", dreamer = "Dreamer"
    }

    public static func load(from url: URL, paths: TaskSquadPaths = .init()) throws -> Self {
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ConfigurationError("config file not found at \(url.path)\nRun: tsq init")
        }
        return try parse(String(contentsOf: url, encoding: .utf8), paths: paths)
    }

    public static func parse(_ source: String, paths: TaskSquadPaths = .init()) throws -> Self {
        let root = try TOMLDocument(source).root
        var result = Self()
        func table(_ key: String) throws -> [String: TOMLValue] {
            guard let value = root[key] else { return [:] }
            guard case .table(let fields) = value else { throw ConfigurationError("\(key) must be a table") }
            return fields
        }
        func string(_ table: [String: TOMLValue], _ key: String, _ fallback: String = "") throws -> String {
            guard let value = table[key] else { return fallback }
            guard case .string(let s) = value else { throw ConfigurationError("\(key) must be a string") }
            return s
        }
        func integer(_ table: [String: TOMLValue], _ key: String, _ fallback: Int) throws -> Int {
            guard let value = table[key] else { return fallback }
            guard case .integer(let n) = value, let result = Int(exactly: n) else { throw ConfigurationError("\(key) must be an integer") }
            return result
        }
        let server = try table("server")
        result.server.url = try string(server, "url", result.server.url)
        result.server.pollInterval = try integer(server, "poll_interval", result.server.pollInterval)
        result.hooks.port = try integer(table("hooks"), "port", result.hooks.port)
        result.ui.port = try integer(table("ui"), "port", result.ui.port)
        let firebase = try table("firebase")
        result.firebase.apiKey = try string(firebase, "api_key")
        result.firebase.authDomain = try string(firebase, "auth_domain")
        let analytics = try table("analytics")
        result.analytics.apiKey = try string(analytics, "api_key", result.analytics.apiKey)
        if let value = analytics["enabled"] {
            guard case .bool(let flag) = value else { throw ConfigurationError("enabled must be a boolean") }
            result.analytics.enabled = flag
        }
        if root["supervisor"] != nil { result.supervisor = try Supervisor(command: string(table("supervisor"), "command")) }
        if root["dreamer"] != nil {
            let dreamer = try table("dreamer")
            result.dreamer = try Dreamer(command: string(dreamer, "command"),
                                        windowStart: string(dreamer, "window_start"), windowEnd: string(dreamer, "window_end"))
        }
        if let entries = root["agents"] {
            guard case .array(let array) = entries else { throw ConfigurationError("agents must be an array of tables") }
            for (index, entry) in array.enumerated() {
                guard case .table(let fields) = entry else { throw ConfigurationError("agents[\(index)] must be a table") }
                let id = try string(fields, "id")
                guard !id.isEmpty else { throw ConfigurationError("agents[\(index)].id is required") }
                result.agents.append(try Agent(id: id, name: string(fields, "name"), command: string(fields, "command"),
                                               workDir: paths.expandHome(string(fields, "work_dir")), provider: string(fields, "provider")))
            }
        }
        guard !result.agents.isEmpty else { throw ConfigurationError("at least one [[agents]] entry is required") }
        // Deliberately not checking agent ID uniqueness here: Go's config.Load
        // doesn't either (see packages/daemon/config/config.go), and this parser
        // exists to match it byte-for-byte (see GoCompatibilityTests). A config
        // accepted by the Go binary must still be accepted by --check-config.
        // DaemonEngine.start() enforces uniqueness as an engine-capability gate.
        return result
    }

    public var dashboardURL: String {
        if let override = ProcessInfo.processInfo.environment["TSQ_DASHBOARD_URL"], !override.isEmpty { return override }
        if server.url == "https://api.tasksquad.ai" || server.url.hasSuffix(".api.tasksquad.ai") { return "https://tasksquad.ai" }
        return server.url.hasSuffix("/api") ? String(server.url.dropLast(4)) : server.url
    }
}

public struct ConfigurationError: LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Observe the directory, not the inode: editors often replace config.toml atomically.
public final class ConfigurationWatcher: @unchecked Sendable {
    private let source: DispatchSourceFileSystemObject
    public init(url: URL, paths: TaskSquadPaths = .init(),
                onChange: @escaping @Sendable (Result<DaemonConfiguration, Error>) -> Void) throws {
        let fd = open(url.deletingLastPathComponent().path, O_EVTONLY | O_CLOEXEC)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let queue = DispatchQueue(label: "ai.tasksquad.configuration")
        source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd,
            eventMask: [.write, .rename, .delete], queue: queue)
        // Access is confined to the serial queue.
        var previous = try? Data(contentsOf: url)
        source.setEventHandler {
            guard let data = try? Data(contentsOf: url), data != previous else { return }
            previous = data
            onChange(Result { try DaemonConfiguration.load(from: url, paths: paths) })
        }
        source.setCancelHandler { close(fd) }
        source.resume()
    }
    deinit { source.cancel() }
}

import Foundation

public struct ObservedAgent: Decodable, Identifiable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let mode: String
    public let taskID: String
    public let logPath: String
    public let session: String
    public let pullAgo: String
    public let workDir: String
    public let command: String
    public let provider: String
    enum CodingKeys: String, CodingKey {
        case id, name, mode, session, command, provider
        case taskID = "task_id", logPath = "log_path", pullAgo = "pull_ago", workDir = "work_dir"
    }
}

/// Read-only observation of an existing Go daemon during side-by-side migration.
/// The Swift engine supplies its own snapshots when running; it never uses this
/// endpoint to execute tasks or as an embedded backend.
public enum AgentObservation {
    public static func read(port: Int, transport: any HTTPTransport = NativeHTTPTransport()) async throws -> [ObservedAgent] {
        guard (1...65535).contains(port) else { return [] }
        let url = URL(string: "http://127.0.0.1:\(port)/api/status")!
        var request = URLRequest(url: url); request.timeoutInterval = 2
        let result = try await transport.send(request)
        try result.requireSuccess()
        struct Status: Decodable { let agents: [ObservedAgent] }
        return try JSONDecoder().decode(Status.self, from: result.data).agents
    }
}

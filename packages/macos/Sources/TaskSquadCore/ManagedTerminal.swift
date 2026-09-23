import Foundation

public struct ManagedTerminalTarget: Sendable, Equatable, Codable {
    public let agentID: String
    public let taskID: String
    public let session: String
    public init(agentID: String, taskID: String, session: String) {
        self.agentID = agentID; self.taskID = taskID; self.session = session
    }
    enum CodingKeys: String, CodingKey { case agentID = "agent_id", taskID = "task_id", session }
}

/// Only managed actions pass through the daemon; tmux still supplies screen data.
public struct ManagedTerminalClient: Sendable {
    public let port: Int
    public let transport: any HTTPTransport
    public init(port: Int, transport: any HTTPTransport = NativeHTTPTransport()) {
        self.port = port; self.transport = transport
    }
    public func send(_ bytes: Data, submit: Bool, pane: String, target: ManagedTerminalTarget) async throws {
        try await request("input", target: target, extra: ["data": bytes.base64EncodedString(), "pane": pane, "submit": submit])
    }
    public func close(_ target: ManagedTerminalTarget) async throws { try await request("close", target: target) }
    private func request(_ action: String, target: ManagedTerminalTarget, extra: [String: Any] = [:]) async throws {
        guard (1...65535).contains(port) else { throw URLError(.badURL) }
        var body = extra
        body["agent_id"] = target.agentID; body["task_id"] = target.taskID; body["session"] = target.session
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/hooks/terminal/\(action)")!, timeoutInterval: 5)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let result = try await transport.send(request)
        if result.status == 404 || result.status == 501 { throw ManagedTerminalError.updateRequired }
        if result.status == 409 { throw ManagedTerminalError.sessionChanged }
        try result.requireSuccess()
    }
}

public enum ManagedTerminalError: LocalizedError {
    case updateRequired, sessionChanged, ownerUnavailable, closePending
    public var errorDescription: String? {
        switch self {
        case .updateRequired: "Update the Go daemon to control managed sessions from this app."
        case .sessionChanged: "The task session changed or is closing. Reopen its terminal from Agents."
        case .ownerUnavailable: "Waiting for the daemon to identify this task session. Reopen it from Agents once connected."
        case .closePending: "Task close was requested. The daemon is still finishing cleanup."
        }
    }
}

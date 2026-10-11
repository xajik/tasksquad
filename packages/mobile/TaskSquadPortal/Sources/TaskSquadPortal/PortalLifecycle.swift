import Foundation

/// Server-driven Portal state shared by both terminal screens. The daemon moves a
/// Portal from `pending` (queued for the agent) to `running` (tmux session up,
/// `session_id` set) to `done` or `failed` (`worker/src/routes/portals.ts`).
public struct PortalLifecycle: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case waiting, starting, connected(sessionID: String), failed, ended
    }
    public let phase: Phase
    public let status: String

    public init(_ record: CustomerRecord) {
        status = record.status
        let session = record.text("session_id")
        switch status {
        case "pending": phase = .waiting
        case "running": phase = session.isEmpty ? .starting : .connected(sessionID: session)
        case "failed": phase = .failed
        default: phase = .ended
        }
    }

    /// Pending and running Portals can be closed and count toward the team limit.
    public var isLive: Bool { Self.isLive(status) }
    public static func isLive(_ status: String) -> Bool { ["pending", "running"].contains(status) }
    public var sessionID: String? { if case .connected(let id) = phase { id } else { nil } }

    public var title: String {
        switch phase {
        case .waiting: "Waiting for agent"
        case .starting: "Starting terminal"
        case .connected: "Connected"
        case .failed: "Portal failed"
        case .ended: "Portal completed"
        }
    }
    public var message: String {
        isLive ? "The terminal will connect when the agent starts the session." : "This session has ended."
    }
}

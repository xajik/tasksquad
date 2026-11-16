import Foundation

/// One thing a person can do to a record. Both apps build their toolbars,
/// context menus, swipe actions and menu-bar commands from the same list, so an
/// action is never available on one surface and missing on another.
public struct RecordAction: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable, CaseIterable {
        case edit, duplicate, forward, tokenSaving, logs, terminal
        case approve, reject, clearVerdict
        case convert, critique, archive, restore
        case runNow, pause, resume, createToken, reset
        case close, cancel, closePortal, leave, delete
    }
    /// Where an action belongs: `primary` actions are shown directly, the rest in menus.
    public enum Placement: Sendable { case primary, secondary, feedback, destructive }
    public struct Confirmation: Equatable, Sendable {
        public let title: String, message: String, button: String
    }
    public let kind: Kind
    public let title: String
    /// SF Symbol; system menus, toolbars and swipe actions draw these.
    public let systemImage: String
    public let placement: Placement
    /// A toggle that is currently on, such as the task's current grade.
    public let isOn: Bool
    public let confirmation: Confirmation?
    public var id: String { kind.rawValue }
    public var isDestructive: Bool { placement == .destructive && kind != .close && kind != .closePortal }

    init(_ kind: Kind, _ title: String, _ systemImage: String, _ placement: Placement = .secondary, isOn: Bool = false, confirm: Confirmation? = nil) {
        self.kind = kind; self.title = title; self.systemImage = systemImage; self.placement = placement; self.isOn = isOn; confirmation = confirm
    }
}

public extension WorkspaceStore {
    /// Actions available for `record` in the current section, most used first.
    func actions(for record: CustomerRecord) -> [RecordAction] {
        RecordAction.available(section: section, record: record, canManage: canManage, isOwner: isOwner, userID: profile?.id ?? "")
    }
    /// The request for an action that needs no further input. `nil` for actions
    /// that open a form or another screen (edit, forward, logs, …).
    func operation(_ action: RecordAction.Kind, for record: CustomerRecord) -> WorkspaceOperation? {
        RecordAction.operation(action, section: section, project: projectID, record: record)
    }
}

public extension RecordAction {
    static func available(section: WorkspaceSection, record: CustomerRecord, canManage: Bool, isOwner: Bool, userID: String) -> [RecordAction] {
        let name = section.itemName, paused = record.flag("paused")
        let delete = RecordAction(.delete, "Delete \(name.prefix(1).uppercased() + name.dropFirst())", "trash", .destructive,
                                  confirm: .init(title: "Delete \(record.title)?", message: "This cannot be undone.", button: "Delete"))
        let pause = paused ? RecordAction(.resume, "Resume", "play") : RecordAction(.pause, "Pause", "pause")
        switch section {
        case .inbox, .supervisor:
            let open = !["done", "failed", "cancelled", "wrapping_up"].contains(record.status)
            let grade = record.value["grade"]?.number
            var actions = [RecordAction(.forward, "Forward to Agent…", "arrowshape.turn.up.right", .primary),
                           RecordAction(.logs, "View Logs", "doc.text.magnifyingglass")]
            if !record.text("session_id").isEmpty, !["done", "failed", "cancelled"].contains(record.status) {
                actions.append(.init(.terminal, "Live Terminal", "terminal"))
            }
            actions.append(.init(.tokenSaving, "Token Saving…", "leaf"))
            actions.append(.init(.approve, "Mark Helpful", "hand.thumbsup", .feedback, isOn: grade == 1))
            actions.append(.init(.reject, "Mark Unhelpful", "hand.thumbsdown", .feedback, isOn: grade == 0))
            if open {
                actions.append(.init(.close, "Close Task", "checkmark.circle", .destructive,
                                     confirm: .init(title: "Close this task?", message: "The agent finishes its work and closes the session. The task stays in your inbox.", button: "Close Task")))
                actions.append(.init(.cancel, "Cancel Task", "xmark.circle", .destructive,
                                     confirm: .init(title: "Cancel this task?", message: "The agent stops working on it. The task stays in your inbox as cancelled.", button: "Cancel Task")))
            }
            actions.append(.init(.delete, "Delete Task", "trash", .destructive,
                                 confirm: .init(title: "Delete this task?", message: "The task and all its messages are removed permanently.", button: "Delete")))
            return actions
        case .notes:
            let archived = record.number("archived_at") > 0
            return [.init(.edit, "Edit", "pencil", .primary),
                    .init(.convert, "Send to Inbox…", "tray.and.arrow.down"),
                    .init(.critique, "Ask for Critique…", "sparkles"),
                    archived ? .init(.restore, "Restore Note", "tray.and.arrow.up") : .init(.archive, "Archive Note", "archivebox"),
                    .init(.delete, "Delete Note", "trash", .destructive,
                          confirm: .init(title: "Delete \(record.title)?", message: "The note and its comments are removed permanently.", button: "Delete"))]
        case .portals:
            guard PortalLifecycle.isLive(record.status) else { return [] }
            return [.init(.closePortal, "Close Portal", "xmark.circle", .destructive,
                          confirm: .init(title: "Close this portal?", message: "The remote terminal session ends.", button: "Close Portal"))]
        case .conveyors:
            guard canManage else { return [] }
            return [.init(.edit, "Edit", "pencil", .primary), .init(.runNow, "Run Now", "play.circle", .primary), pause, delete]
        case .planners:
            let verdict = record.value["planner_verdict"]?.number
            var actions = [RecordAction(.approve, "Approve", "hand.thumbsup", .feedback, isOn: verdict == 1),
                           RecordAction(.reject, "Reject", "hand.thumbsdown", .feedback, isOn: verdict == 0)]
            if verdict != nil { actions.append(.init(.clearVerdict, "Clear Verdict", "arrow.uturn.backward", .feedback)) }
            if canManage { actions.insert(pause, at: 0); actions.append(delete) }
            return actions
        case .skills, .subAgents, .commands:
            guard canManage else { return [] }
            var actions = [RecordAction(.duplicate, "Duplicate", "plus.square.on.square")]
            if !record.flag("is_default") { actions.insert(.init(.edit, "Edit", "pencil", .primary), at: 0); actions.append(delete) }
            return actions
        case .agents:
            guard canManage else { return [] }
            return [.init(.edit, "Edit Role", "pencil", .primary), pause,
                    .init(.createToken, "Create Agent Token", "key"),
                    .init(.reset, "Reset Agent", "arrow.counterclockwise", .destructive,
                          confirm: .init(title: "Reset \(record.title)?", message: "This requests a reset of the agent's current session.", button: "Reset")),
                    delete]
        case .members:
            if record.id == userID {
                guard record.text("role") != "owner" else { return [] }
                return [.init(.leave, "Leave Project", "rectangle.portrait.and.arrow.right", .destructive,
                              confirm: .init(title: "Leave this project?", message: "You lose access until you are invited again.", button: "Leave"))]
            }
            guard isOwner else { return [] }
            return [.init(.delete, "Remove Member", "person.badge.minus", .destructive,
                          confirm: .init(title: "Remove \(record.title)?", message: "They lose access to this project.", button: "Remove"))]
        case .memory, .analytics, .settings: return []
        }
    }

    static func operation(_ kind: Kind, section: WorkspaceSection, project: String, record: CustomerRecord) -> WorkspaceOperation? {
        let id = record.id, task = [.inbox, .supervisor].contains(section)
        switch kind {
        case .approve, .reject:
            let value: Double = kind == .approve ? 1 : 0
            if task { return .grade(task: id, record.value["grade"]?.number == value ? nil : value) }
            if section == .planners { return .plannerVerdict(project: project, planner: id, record.value["planner_verdict"]?.number == value ? nil : value) }
            return nil
        case .clearVerdict: return section == .planners ? .plannerVerdict(project: project, planner: id, nil) : nil
        case .archive: return .archiveNote(project: project, note: id, restore: false)
        case .restore: return .archiveNote(project: project, note: id, restore: true)
        case .runNow: return .runConveyor(project: project, conveyor: record)
        case .pause: return .setPaused(section, project: project, id: id, paused: true)
        case .resume: return .setPaused(section, project: project, id: id, paused: false)
        case .reset: return .resetAgent(project: project, agent: id)
        case .close: return task ? .closeTask(id) : nil
        case .cancel: return task ? .cancelTask(id) : nil
        case .closePortal: return .closePortal(id)
        case .leave: return .delete(.members, project: project, id: id)
        case .delete: return task ? .deleteTask(id) : .delete(section, project: project, id: id)
        case .edit, .duplicate, .forward, .tokenSaving, .logs, .terminal, .convert, .critique, .createToken: return nil
        }
    }
}

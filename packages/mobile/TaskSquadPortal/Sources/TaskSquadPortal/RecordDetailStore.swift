import Foundation
import Combine

/// Each instance belongs to a platform selection. A new selection invalidates
/// all pending requests without disturbing workspace pagination or navigation.
@MainActor public final class RecordDetailStore: ObservableObject {
    @Published public private(set) var detail: CustomerRecord?
    @Published public private(set) var messages: [CustomerRecord] = []
    @Published public private(set) var comments: [CustomerRecord] = []
    @Published public private(set) var related: [CustomerRecord] = []
    @Published public private(set) var error: String?
    @Published public private(set) var loading = false
    private var generation = UUID()
    private var scope = ""
    public init() {}
    public func reset() { generation = UUID(); scope = ""; detail = nil; messages = []; comments = []; related = []; error = nil; loading = false }
    public func refresh(workspace: WorkspaceStore, id: String) async {
        let key = workspace.context, section = workspace.section, project = workspace.projectID
        let nextScope = key + ":" + id
        if scope != nextScope { reset(); scope = nextScope }
        let request = UUID(); generation = request; loading = detail == nil
        defer { if generation == request { loading = false } }
        do {
            let next: CustomerRecord?
            if [.agents, .members, .conveyors].contains(section) { next = workspace.records.first { $0.id == id } }
            else if [.analytics, .settings].contains(section) { next = nil }
            else { next = CustomerRecord(try await workspace.api.request(workspace.path(section, id: id, project: project))) }
            var nextMessages: [CustomerRecord] = [], nextComments: [CustomerRecord] = [], nextRelated: [CustomerRecord] = []
            if [.inbox, .supervisor].contains(section) { nextMessages = CustomerRecord(try await workspace.api.request(["tasks", id, "messages"])).records("messages") }
            if section == .notes {
                async let comments = workspace.api.request(["teams", project, "notes", id, "comments"])
                async let tasks = workspace.api.request(["teams", project, "notes", id, "tasks"])
                (nextComments, nextRelated) = try await (CustomerRecord(comments).records("comments"), CustomerRecord(tasks).records("tasks"))
            }
            if section == .conveyors { nextRelated = CustomerRecord(try await workspace.api.request(["teams", project, "conveyors", id, "tasks"])).records("tasks") }
            guard key == workspace.context, generation == request, !Task.isCancelled else { return }
            detail = next; messages = nextMessages; comments = nextComments; related = nextRelated; error = nil
        } catch {
            guard key == workspace.context, generation == request, !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
            self.error = error.localizedDescription
        }
    }
}

#if DEBUG
import SwiftUI
import TaskSquadCore

/// A disposable native preview: no Keychain, daemon, or network access. The
/// separate preview bundle identifier also isolates window/user preferences.
struct CustomerPreviewApplication: App {
    @NSApplicationDelegateAdaptor(CustomerPreviewDelegate.self) private var delegate
    @StateObject private var customer: CustomerWorkspaceModel
    @StateObject private var control = ControlPanelModel(paths: TaskSquadPaths(home: FileManager.default.temporaryDirectory.appendingPathComponent("tsq-customer-preview")), loadSavedAccount: false)
    init() {
        let api = CustomerAPI(baseURL: URL(string: "https://preview.invalid")!, transport: CustomerPreviewTransport()) { _ in "preview-only" }
        _customer = StateObject(wrappedValue: CustomerWorkspaceModel(api: api))
    }
    var body: some Scene {
        WindowGroup("TaskSquad · Customer Preview") {
            MainWindow(control: control, customer: customer, initialSection: .inbox)
                .frame(minWidth: 1000, minHeight: 650)
        }.defaultSize(width: 1200, height: 800)
    }
}

@MainActor private final class CustomerPreviewDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
}

private actor CustomerPreviewTransport: HTTPTransport {
    private var records: [String: [JSONValue]] = [:]
    private let item: JSONValue = .object([
        "id": .string("preview-task"), "name": .string("Review the native workspace"), "subject": .string("Review the native workspace"),
        "title": .string("Desktop release plan"), "status": .string("waiting_input"), "role": .string("agent"),
        "agent_id": .string("preview-agent"), "sender_id": .string("preview-user"),
        "body": .string("## Ready for review\n\nYour customer workspace uses the same cloud data as the web app.\n\n- [x] Native inbox and replies\n- [x] Independent daemon controls\n- [ ] Review the release"),
        "content": .string("# Desktop release plan\n\nKeep the customer workspace independent from local agent execution."),
        "description": .string("Shared project knowledge"), "created_at": .number(1_790_000_000_000),
        "tags": .array([.string("native"), .string("release")]), "attachments": .array([]), "phases": .array([]), "category": .string("architecture")
    ])
    func send(_ request: URLRequest) async throws -> HTTPResult {
        let path = request.url!.path, parts = path.split(separator: "/").map(String.init)
        let value: JSONValue
        if path == "/me" { value = .object(["id": .string("preview-user"), "email": .string("preview@example.invalid"), "plan": .string("pro")]) }
        else if path == "/teams" { value = .object(["teams": .array([.object(["id": .string("preview-team"), "name": .string("TaskSquad Preview"), "role": .string("owner"), "memory_enabled": .bool(true)])])]) }
        else if parts.last == "agents" { value = .object(["agents": .array([.object(["id": .string("preview-agent"), "name": .string("Builder"), "status": .string("online")])])]) }
        else if request.httpMethod == "POST" || request.httpMethod == "PUT" || request.httpMethod == "PATCH" {
            var fields = (try? JSONDecoder().decode(JSONValue.self, from: request.httpBody ?? Data()))?.object ?? [:]
            fields["id"] = .string(UUID().uuidString); fields["role"] = .string("user"); fields["created_at"] = .number(Date().timeIntervalSince1970 * 1000)
            let key = parts.last ?? "tasks"
            records[key] = (records[key] ?? [item]) + [.object(fields)]
            value = .object(fields)
        } else if parts.last?.hasPrefix("preview-") == true {
            value = item
        } else {
            let resource = parts.last ?? "tasks", envelope = resource == "sub-agents" ? "sub_agents" : resource
            value = .object([envelope: .array(records[resource] ?? [item]), "has_more": .bool(false)])
        }
        return HTTPResult(data: try JSONEncoder().encode(value), status: 200)
    }
}
#endif

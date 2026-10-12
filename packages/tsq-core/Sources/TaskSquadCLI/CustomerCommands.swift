import Foundation
import TaskSquadCore

/// User-authenticated cloud orchestration: `tsq projects|agents|tasks|portals|resources|doctor`.
/// Port of packages/daemon/cmd/customer and api/customer.go. Never starts a daemon or infers a
/// mutation's project from the working directory.
enum CustomerCommands {
    struct Options {
        var group = "", action = "", project = "", id = "", agent = "", subject = "", body = "", file = "", status = "", name = "", config = "", apiURL = ""
        var json = false
        var timeout = 300.0
        var images: [String] = []
    }
    struct Failure: Error { let message: String }
    static let valid = ["projects": "list", "agents": "list create", "tasks": "create get list reply close wait", "portals": "create get list close",
                        "resources": "audit sync", "doctor": ""]

    static func parse(_ input: [String], defaultConfig: String) throws -> Options {
        var o = Options()
        guard let group = input.first else { throw Failure(message: "expected projects, agents, tasks, portals, resources, or doctor") }
        o.group = group
        var args = Array(input.dropFirst())
        if group != "doctor" {
            guard let action = args.first else { throw Failure(message: "subcommand required") }
            o.action = action; args.removeFirst()
        }
        let flags = GoFlagSet("tsq \(o.group) \(o.action)", output: { _ in })
        flags.string("project", "", "explicit project ID"); flags.string("id", "", "task or Portal ID")
        flags.string("agent", "", "agent ID"); flags.string("name", "", "agent name")
        flags.string("subject", "", "task subject"); flags.string("body", "", "message body")
        flags.string("file", "", "UTF-8 body file, or - for stdin"); flags.string("status", "waiting_input", "wait target status")
        flags.string("config", defaultConfig, "config path"); flags.string("api-url", "", "override API URL")
        flags.bool("json", false, "machine-readable output"); flags.duration("timeout", 300, "overall deadline, at most 30m")
        flags.list("image", "image attachment (repeatable)")
        do { try flags.parse(args) } catch { throw Failure(message: flags.lastError.isEmpty ? "flag: help requested" : flags.lastError) }
        guard flags.arguments.isEmpty else { throw Failure(message: "unexpected arguments; use --id for a task or Portal") }
        o.project = flags[string: "project"]; o.id = flags[string: "id"]; o.agent = flags[string: "agent"]; o.name = flags[string: "name"]
        o.subject = flags[string: "subject"]; o.body = flags[string: "body"]; o.file = flags[string: "file"]; o.status = flags[string: "status"]
        o.config = flags[string: "config"]; o.apiURL = flags[string: "api-url"]; o.json = flags[bool: "json"]; o.timeout = flags[duration: "timeout"]
        o.images = flags[list: "image"]
        guard let actions = valid[o.group], o.group == "doctor" || " \(actions) ".contains(" \(o.action) ") else { throw Failure(message: "unsupported command") }
        if o.group != "projects", o.group != "doctor", o.project.isEmpty { throw Failure(message: "--project is required") }
        for id in [o.project, o.id, o.agent] where !id.isEmpty && id.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) == nil {
            throw Failure(message: "invalid ID")
        }
        if ["get", "reply", "close", "wait"].contains(o.action), o.id.isEmpty { throw Failure(message: "--id is required") }
        if o.action == "create", o.group == "tasks" || o.group == "portals", o.agent.isEmpty { throw Failure(message: "--agent is required") }
        if o.group == "tasks", o.action == "create", o.subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw Failure(message: "--subject is required") }
        if o.group == "agents", o.action == "create", o.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw Failure(message: "--name is required") }
        if !o.body.isEmpty, !o.file.isEmpty { throw Failure(message: "use either --body or --file") }
        if o.timeout <= 0 || o.timeout > 1800 { throw Failure(message: "--timeout must be between 0 and 30m") }
        return o
    }

    static func run(_ args: [String], version: String, _ c: CLIContext) async -> Int32 {
        var o: Options
        do { o = try parse(args, defaultConfig: c.paths.config.path) } catch let error as Failure { c.printError(error.message); return 2 } catch { return 2 }
        if !o.file.isEmpty {
            let data: Data
            if o.file == "-" { data = c.stdin() } else {
                guard let contents = FileManager.default.contents(atPath: o.file) else { c.printError("cannot read body file"); return 2 }
                data = contents
            }
            guard data.count <= 1024 * 1024 else { c.printError("body exceeds 1 MiB or cannot be read"); return 2 }
            o.body = String(decoding: data, as: UTF8.self)
        }
        if o.action == "reply", o.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { c.printError("reply body is required"); return 2 }
        guard var configuration = try? DaemonConfiguration.loadCustomer(from: URL(fileURLWithPath: o.config), paths: c.paths) else {
            c.printError("Cannot load configuration; run tsq init or supply --config."); return 1
        }
        if !o.apiURL.isEmpty { configuration.server.url = o.apiURL }
        if o.group == "doctor" {
            var checks: [String: GoJSONValue] = ["version": .string(version), "config_valid": .bool(FileManager.default.fileExists(atPath: o.config)),
                                                 "authenticated": .bool(await c.isLoggedIn(c.environment))]
            for name in ["tmux", "claude", "codex"] { checks[name] = .string(ExecutableLocator.find(name, environment: c.environment) ?? "") }
            emit(.object(checks), json: o.json, c)
            return 0
        }
        let token: String
        do { token = try await c.tokenProvider(configuration).token(forceRotation: false) } catch { c.printError("Authentication failed; run tsq login."); return 1 }
        let client = CustomerClient(baseURL: configuration.server.url, token: token, transport: c.customerTransport, readFile: { FileManager.default.contents(atPath: $0) })
        let deadline = Date().addingTimeInterval(o.timeout)
        var result: GoJSONValue?
        do {
            if o.group == "resources" {
                guard !configuration.agents.isEmpty else { c.printError("Resources sync needs configured local agents; run tsq init first."); return 1 }
                result = try await resources(client, configuration, o, c)
            } else {
                result = try await execute(client, o, deadline: deadline) { result = $0 }
            }
        } catch let failure as Failure {
            if let result { emit(result, json: o.json, c) }
            c.printError(failure.message)
            return failure.message == "context deadline exceeded" ? 3 : 1
        } catch {
            c.printError(error.localizedDescription); return 1
        }
        if let result { emit(result, json: o.json, c) }
        return 0
    }

    static func execute(_ client: CustomerClient, _ o: Options, deadline: Date, partial: (GoJSONValue) -> Void = { _ in }) async throws -> GoJSONValue {
        if o.group == "projects" { return try await client.request("GET", "/teams", deadline: deadline) }
        if o.group == "agents" {
            let path = "/teams/\(o.project)/agents"
            return o.action == "create" ? try await client.request("POST", path, body: ["name": .string(o.name)], deadline: deadline)
                                        : try await client.request("GET", path, deadline: deadline)
        }
        let base = "/" + o.group
        if o.action == "list" { return try await client.request("GET", base + "?team_id=" + GoJSON.queryEscape(o.project), deadline: deadline) }
        if o.action == "create" {
            var body: [String: GoJSONValue] = ["team_id": .string(o.project), "agent_id": .string(o.agent)]
            if o.group == "tasks" { body["subject"] = .string(o.subject); body["body"] = .string(o.body) }
            return try await client.request("POST", base, body: body, files: o.images, deadline: deadline)
        }
        let path = base + "/" + o.id
        while true {
            var record = try await client.request("GET", path, deadline: deadline)
            guard record["team_id"] == .string(o.project) else { throw Failure(message: "record does not belong to --project") }
            switch o.action {
            case "close": return try await client.request("POST", path + "/close", body: [:], deadline: deadline)
            case "reply": return try await client.request("POST", path + "/messages", body: ["body": .string(o.body)], files: o.images, deadline: deadline)
            case "get":
                if o.group == "tasks", case .object(var fields) = record {
                    let messages = try await client.request("GET", path + "/messages", deadline: deadline)
                    fields["messages"] = messages["messages"] ?? .null
                    record = .object(fields)
                }
                return record
            case "wait":
                let status = record["status"]
                if status == .string(o.status) { return record }
                if let s = status?.string, ["done", "failed", "cancelled"].contains(s) {
                    partial(record); throw Failure(message: "task reached \(s) before \(o.status)")
                }
                if Date() >= deadline { partial(record); throw Failure(message: "context deadline exceeded") }
                try await Task.sleep(for: .seconds(min(1, max(0, deadline.timeIntervalSinceNow))))
                if Date() >= deadline { partial(record); throw Failure(message: "context deadline exceeded") }
            default: throw Failure(message: "unsupported action")
            }
        }
    }

    static func providerBase(_ provider: String) -> String {
        switch provider {
        case "claude-code": ".claude"
        case "codex", "opencode": ".agents"
        case "gemini": ".gemini"
        case "pi": ".pi"
        case "claw": ".agent"
        default: ""
        }
    }

    /// Audit (and with `sync`, first install) server-managed resources for the project's local agents.
    static func resources(_ client: CustomerClient, _ configuration: DaemonConfiguration, _ o: Options, _ c: CLIContext) async throws -> GoJSONValue {
        let project = try await client.request("GET", "/teams/\(o.project)/agents", deadline: .distantFuture)
        let ids = Set((project["agents"]?.array ?? []).compactMap { $0["id"]?.string }.filter { !$0.isEmpty })
        let targets = configuration.agents.filter { ids.contains($0.id) }
        guard !targets.isEmpty else { throw Failure(message: "no configured daemon agents belong to --project") }
        if o.action == "sync" {
            await ResourceSyncNow.run(configuration: configuration, agents: targets, tokens: c.tokenProvider(configuration), transport: c.transport, paths: c.paths)
        }
        var missing: [GoJSONValue] = []
        for agent in targets {
            let provider = ProviderKind.detect(command: agent.command, override: agent.provider).rawValue
            for (endpoint, envelope) in [("/daemon/user/skills", "skills"), ("/daemon/user/sub-agents", "sub_agents"), ("/daemon/user/commands", "commands")] {
                let response = try await client.request("GET", endpoint + "?agent_id=" + GoJSON.queryEscape(agent.id), deadline: .distantFuture)
                for item in response[envelope]?.array ?? [] {
                    guard let name = item["name"]?.string, !name.isEmpty else { continue }
                    guard (item["auto_install"]?.number ?? 0) != 0 || (item["is_default"]?.number ?? 0) != 0 else { continue }
                    if let team = item["team_id"]?.string, !team.isEmpty, team != o.project { continue }
                    let folder = envelope == "sub_agents" ? "agents" : envelope
                    let canonical = envelope == "skills" ? "\(agent.workDir)/.tsq/\(folder)/\(name)/SKILL.md" : "\(agent.workDir)/.tsq/\(folder)/\(name).md"
                    guard FileManager.default.fileExists(atPath: canonical) else { missing.append(.string("\(agent.id):\(envelope):\(name)")); continue }
                    let base = providerBase(provider)
                    if !base.isEmpty {
                        let relative = envelope == "skills" ? "\(base)/skills/\(name)/SKILL.md" : "\(base)/\(folder)/\(name).md"
                        if !FileManager.default.fileExists(atPath: "\(agent.workDir)/\(relative)") { missing.append(.string("\(agent.id):provider:\(name)")) }
                    }
                }
            }
        }
        return .object(["project_id": .string(o.project), "agents": .number(String(targets.count)), "missing": missing.isEmpty ? .null : .array(missing),
                        "healthy": .bool(missing.isEmpty), "synced": .bool(o.action == "sync")])
    }

    /// Responses may grow credential fields; redact recursively before printing.
    static func redact(_ value: GoJSONValue) -> GoJSONValue {
        switch value {
        case .object(let fields):
            return .object(Dictionary(uniqueKeysWithValues: fields.map { key, val in
                let k = key.lowercased()
                return (key, ["token", "secret", "password", "credential"].contains { k.contains($0) } ? .string("[redacted]") : redact(val))
            }))
        case .array(let items): return .array(items.map(redact))
        default: return value
        }
    }

    static func emit(_ value: GoJSONValue, json: Bool, _ c: CLIContext) {
        c.stdout(redact(value).encoded(indent: json ? "" : "  "))
    }
}

/// api.CustomerClient: user-scoped bearer auth, never the agent header, no redirects, Go's error text.
struct CustomerClient {
    let baseURL: String
    let token: String
    let transport: any HTTPTransport
    let readFile: (String) -> Data?

    func request(_ method: String, _ path: String, body: [String: GoJSONValue]? = nil, files: [String] = [], deadline: Date) async throws -> GoJSONValue {
        guard let base = URLComponents(string: baseURL), let host = base.host, !host.isEmpty, base.user == nil, ["https", "http"].contains(base.scheme ?? "") else {
            throw CustomerCommands.Failure(message: "invalid API URL")
        }
        let trimmed = baseURL.hasSuffix("/") ? String(baseURL.reversed().drop { $0 == "/" }.reversed()) : baseURL
        guard let url = URL(string: trimmed + path) else { throw CustomerCommands.Failure(message: "invalid request") }
        var request = URLRequest(url: url, timeoutInterval: max(1, min(60, deadline.timeIntervalSinceNow)))
        request.httpMethod = method
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if !files.isEmpty {
            guard files.count <= 3 else { throw CustomerCommands.Failure(message: "at most three images are allowed") }
            let boundary = (0..<30).map { _ in String(format: "%x", Int.random(in: 0..<16)) }.joined()
            var data = Data()
            for (key, value) in body ?? [:] {
                let text = value.string ?? String(value.encoded(indent: "").dropLast())
                data.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(text)\r\n".utf8))
            }
            for file in files {
                let name = URL(fileURLWithPath: file).lastPathComponent
                guard let contents = readFile(file) else { throw CustomerCommands.Failure(message: "cannot open attachment \(name)") }
                guard contents.count <= 8 * 1024 * 1024 else { throw CustomerCommands.Failure(message: "attachment exceeds 8 MiB or cannot be read") }
                let mime = Self.sniff(contents)
                guard ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(mime) else { throw CustomerCommands.Failure(message: "unsupported image type: \(mime)") }
                let safe = name.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_")
                    .replacingOccurrences(of: "\n", with: "_").replacingOccurrences(of: "\\", with: "_")
                data.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"images\"; filename=\"\(safe)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8))
                data.append(contents); data.append(Data("\r\n".utf8))
            }
            data.append(Data("--\(boundary)--\r\n".utf8))
            request.httpBody = data
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        } else if let body {
            request.httpBody = Data(GoJSONValue.object(body).encoded(indent: "").utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let result: HTTPResult
        do { result = try await transport.send(request) } catch {
            if Date() >= deadline { throw CustomerCommands.Failure(message: "context deadline exceeded") }
            throw CustomerCommands.Failure(message: "API request failed")
        }
        guard (200..<300).contains(result.status) else { throw CustomerCommands.Failure(message: "API HTTP \(result.status)") }
        if result.status == 204 { return .object(["ok": .bool(true)]) }
        guard result.data.count <= 16 * 1024 * 1024, let value = try? GoJSONValue.parse(result.data), case .object = value else {
            throw CustomerCommands.Failure(message: "invalid API response")
        }
        return value
    }

    /// The image types http.DetectContentType recognises.
    static func sniff(_ data: Data) -> String {
        let b = [UInt8](data.prefix(14))
        if b.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
        if b.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if b.starts(with: Array("GIF87a".utf8)) || b.starts(with: Array("GIF89a".utf8)) { return "image/gif" }
        if b.count >= 14, b.starts(with: Array("RIFF".utf8)), Array(b[8..<14]) == Array("WEBPVP".utf8) { return "image/webp" }
        return data.isEmpty ? "text/plain; charset=utf-8" : "application/octet-stream"
    }
}

/// Returns 3xx responses instead of following them, so the bearer token never leaves the API origin.
final class NoRedirectTransport: NSObject, HTTPTransport, URLSessionTaskDelegate, @unchecked Sendable {
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()
    // The completion-handler form: swift-corelibs URLSession (Linux) never calls the async one.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
    func send(_ request: URLRequest) async throws -> HTTPResult {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return HTTPResult(data: data, status: http.statusCode)
    }
}

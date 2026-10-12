import Foundation
import TaskSquadCore

/// `tsq memory`, `tsq kb` and `tsq tags` (Go: cmd/memory, cmd/kb, cmd/tags).
enum KnowledgeCommands {
    static let memoryUsage = "usage: tsq memory push --scope local|global --category <c> --title <t> [--tags a,b] --file <path>\n       tsq memory search <query>"

    private static func api(_ configuration: DaemonConfiguration, _ c: CLIContext) -> WorkerAPI {
        WorkerAPI(baseURL: configuration.server.url, transport: c.transport)
    }

    /// Go's api.Post/Get failure: "HTTP <code>: <body>".
    struct ResponseError: LocalizedError { let status: Int; let body: String
        var errorDescription: String? { "HTTP \(status): \(body)" }
    }
    static func describe(_ error: Error) -> String { error.localizedDescription }

    static func request(_ method: String, _ path: String, agentID: String, body: JSONValue? = nil,
                        _ configuration: DaemonConfiguration, _ c: CLIContext) async throws -> JSONValue {
        let token = try await c.tokenProvider(configuration).token(forceRotation: false)
        let request = try api(configuration, c).request(method: method, path: path, token: token, agentID: agentID, body: body)
        let result = try await c.transport.send(request)
        guard (200..<300).contains(result.status) else { throw ResponseError(status: result.status, body: String(decoding: result.data, as: UTF8.self)) }
        return result.data.isEmpty ? .object([:]) : ((try? JSONDecoder().decode(JSONValue.self, from: result.data)) ?? .object([:]))
    }

    static func memory(_ args: [String], _ c: CLIContext) async -> Int32 {
        guard let sub = args.first else { c.printError(memoryUsage); return 1 }
        switch sub {
        case "push": return await memoryPush(Array(args.dropFirst()), c)
        case "search": return await memorySearch(Array(args.dropFirst()), c)
        default: c.printError("unknown memory subcommand \(GoFlagSet.goQuote(sub)) — expected push or search"); return 1
        }
    }

    private static func memoryPush(_ args: [String], _ c: CLIContext) async -> Int32 {
        let flags = GoFlagSet("memory push", output: c.stderr)
        flags.string("scope", "", "local | global (required)")
        flags.string("category", "", "personal | preferences | structure | architecture | events (required)")
        flags.string("title", "", "short title (required)")
        flags.string("tags", "", "comma-separated tags")
        flags.string("file", "", "path to markdown content (reads stdin if omitted)")
        do { try flags.parse(args) } catch { return 1 }
        let scope = flags[string: "scope"], category = flags[string: "category"], title = flags[string: "title"]
        guard scope == "local" || scope == "global" else { c.printError("error: --scope must be \"local\" or \"global\""); c.printError(memoryUsage); return 1 }
        guard LocalKnowledge.categories.contains(category) else {
            c.printError("error: --category must be one of personal, preferences, structure, architecture, events"); c.printError(memoryUsage); return 1
        }
        guard !title.isEmpty else { c.printError("error: --title is required"); c.printError(memoryUsage); return 1 }
        let content: String
        if !flags[string: "file"].isEmpty {
            guard let data = FileManager.default.contents(atPath: flags[string: "file"]) else {
                c.printError("error reading content: open \(flags[string: "file"]): no such file or directory"); return 1
            }
            content = String(decoding: data, as: UTF8.self)
        } else { content = String(decoding: c.stdin(), as: UTF8.self) }
        let tags = LocalKnowledge.splitTags(flags[string: "tags"])
        if scope == "local" {
            do {
                let path = try LocalKnowledge.writeMemory(workDir: c.workingDirectory, category: category, title: title, content: content,
                                                          tags: tags, now: c.now(), timeZone: c.timeZone)
                c.print("Saved local memory entry: \(path)")
                return 0
            } catch { c.printError("error writing local memory: \(error.localizedDescription)"); return 1 }
        }
        let configuration: DaemonConfiguration
        do { configuration = try c.loadConfiguration() } catch { c.printError("error loading config: \(error.localizedDescription)"); return 1 }
        let agentID = c.currentAgentID(configuration)
        if agentID.isEmpty {
            c.printError("warning: could not resolve the current agent from work_dir \(GoFlagSet.goQuote(c.workingDirectory)) — the server will reject this push")
        }
        do {
            let response = try await request("POST", "/daemon/memory", agentID: agentID, body: .object([
                "category": .string(category), "title": .string(title), "content": .string(content), "tags": .array(tags.map(JSONValue.string))]),
                configuration, c)
            // Go prints "HTTP 200" for any 2xx, the response re-encoded with sorted keys.
            c.print("HTTP 200: \(GoJSON.encode(response))")
            return 0
        } catch let error as ConfigurationError where error.localizedDescription.contains("auth") {
            c.printError("auth error: \(error.localizedDescription)"); return 1
        } catch { c.printError("error pushing memory: \(describe(error))"); return 1 }
    }

    private static func printMemory(_ e: KnowledgeEntry, _ c: CLIContext) {
        let tags = e.tags.isEmpty ? "" : " [" + e.tags.joined(separator: ", ") + "]"
        c.print("[\(e.scope)] (\(e.category)) \(e.title)\(tags)\n    \(e.excerpt)")
    }

    private static func memorySearch(_ args: [String], _ c: CLIContext) async -> Int32 {
        guard !args.isEmpty else { c.printError("usage: tsq memory search <query>"); return 1 }
        let query = args.joined(separator: " ")
        let local = LocalKnowledge.searchMemory(workDir: c.workingDirectory, query: query)
        var global: [KnowledgeEntry] = [], globalError: String?
        do {
            let configuration = try c.loadConfiguration()
            let agentID = c.currentAgentID(configuration)
            guard !agentID.isEmpty else { throw ConfigurationError("current directory doesn't match any configured agent's work_dir") }
            let escaped = GoJSON.queryEscape(query)
            let response = try await request("GET", "/daemon/memory/search?q=" + escaped, agentID: agentID, configuration, c)
            for item in response["memory"]?.array ?? [] {
                guard case .object = item else { continue }
                var content = (item["content"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if content.utf8.count > 160 { content = String(decoding: Array(content.utf8)[..<160], as: UTF8.self) + "…" }
                global.append(KnowledgeEntry(scope: "global", category: item["category"]?.string ?? "", title: item["title"]?.string ?? "", excerpt: content))
            }
        } catch { globalError = describe(error) }
        for entry in local + global { printMemory(entry, c) }
        if local.isEmpty, global.isEmpty, globalError == nil { c.print("No memory entries found.") }
        if let globalError { c.printError("global search unavailable (showing local results only): \(globalError)") }
        return 0
    }

    static func kb(_ args: [String], _ c: CLIContext) async -> Int32 {
        guard let sub = args.first else { c.printError("usage: tsq kb search <query>\n       tsq kb init"); return 1 }
        switch sub {
        case "search":
            let rest = Array(args.dropFirst())
            guard !rest.isEmpty else { c.printError("usage: tsq kb search <query>"); return 1 }
            let entries = LocalKnowledge.searchKB(workDir: c.workingDirectory, query: rest.joined(separator: " "))
            if entries.isEmpty { c.print("No knowledge base entries found."); return 0 }
            for e in entries {
                let tags = e.tags.isEmpty ? "" : " [" + e.tags.joined(separator: ", ") + "]"
                c.print("\(e.title)\(tags)\n    \(e.path)\n    \(e.excerpt)")
            }
            return 0
        case "init":
            let configuration: DaemonConfiguration
            do { configuration = try c.loadConfiguration() } catch { c.printError("error loading config: \(error.localizedDescription)"); return 1 }
            let agentID = c.currentAgentID(configuration)
            if agentID.isEmpty {
                c.printError("warning: could not resolve the current agent from work_dir \(GoFlagSet.goQuote(c.workingDirectory)) — continuing without one")
            }
            do {
                let started = try await KnowledgeBaseInit.start(configuration: configuration, workDir: c.workingDirectory, agentID: agentID,
                                                               paths: c.paths, environment: c.environment, tmux: c.tmux)
                c.print("KB bootstrap started: \(started.session)")
                c.print("Attach to watch: tmux attach-session -t \(started.session)")
                c.print("Log: \(started.log.path)")
                return 0
            } catch { c.printError("error starting kb init: \(error.localizedDescription)"); return 1 }
        default:
            c.printError("unknown kb subcommand \(GoFlagSet.goQuote(sub)) — expected search or init"); return 1
        }
    }

    static func tags(_ args: [String], _ c: CLIContext) async -> Int32 {
        guard args.first == "pull" else { c.printError("usage: tsq tags pull"); return 1 }
        let configuration: DaemonConfiguration
        do { configuration = try c.loadConfiguration() } catch { c.printError("error loading config: \(error.localizedDescription)"); return 1 }
        let teamID: String
        do {
            let agentID = c.currentAgentID(configuration)
            guard !agentID.isEmpty else {
                throw ConfigurationError("current directory \(GoFlagSet.goQuote(c.workingDirectory)) doesn't match any configured agent's work_dir")
            }
            let agents = try await request("GET", "/daemon/user/agents", agentID: "", configuration, c)
            guard let agent = agents["agents"]?.array?.first(where: { $0["id"]?.string == agentID }) else {
                throw ConfigurationError("agent \(agentID) not found in /daemon/user/agents response")
            }
            guard let team = agent["team_id"]?.string, !team.isEmpty else { throw ConfigurationError("agent \(agentID) has no team_id in /daemon/user/agents response") }
            teamID = team
        } catch { c.printError("error resolving team: \(describe(error))"); return 1 }
        do {
            let response = try await request("GET", "/teams/\(teamID)/tags", agentID: "", configuration, c)
            let tags = response["tags"]?.array ?? []
            if tags.isEmpty { c.print("No tags."); return 0 }
            for tag in tags { if let name = tag["name"]?.string, !name.isEmpty { c.print(name) } }
            return 0
        } catch { c.printError("error fetching tags: \(describe(error))"); return 1 }
    }
}

/// Go encoding/json conventions the CLI prints.
enum GoJSON {
    /// json.Marshal of a decoded object: sorted keys, HTML-escaped <>&, no escaped slashes.
    static func encode(_ value: JSONValue) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: value.foundation, options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed])) ?? Data()
        return String(decoding: data, as: UTF8.self).replacingOccurrences(of: "<", with: "\\u003c")
            .replacingOccurrences(of: ">", with: "\\u003e").replacingOccurrences(of: "&", with: "\\u0026")
    }

    /// url.QueryEscape: spaces become "+", everything but [A-Za-z0-9-_.~] is percent-encoded.
    static func queryEscape(_ s: String) -> String {
        var out = ""
        for byte in s.utf8 {
            switch byte {
            case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "-"), UInt8(ascii: "_"), UInt8(ascii: "."), UInt8(ascii: "~"): out.unicodeScalars.append(Unicode.Scalar(byte))
            case UInt8(ascii: " "): out += "+"
            default: out += String(format: "%%%02X", byte)
            }
        }
        return out
    }
}

extension JSONValue {
    /// Foundation form for JSONSerialization.
    var foundation: Any {
        switch self {
        case .object(let o): o.mapValues(\.foundation)
        case .array(let a): a.map(\.foundation)
        case .string(let s): s
        case .number(let n): n.rounded() == n && abs(n) < 1e15 ? NSNumber(value: Int64(n)) : NSNumber(value: n)
        case .bool(let b): b
        case .null: NSNull()
        }
    }
}

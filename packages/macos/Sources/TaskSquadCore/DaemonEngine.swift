import Foundation

public struct AgentSnapshot: Sendable, Identifiable {
    public let id: String
    public let name: String
    public let mode: AgentMode
    public let taskID: String
    public let sessionID: String
}

/// Embedded engine. This first execution path supports stdout providers; the
/// engine refuses to claim work for configurations whose provider integrations
/// have not been implemented yet. The compatibility ledger tracks the full scope.
public actor DaemonEngine {
    private struct AgentRuntime {
        let configuration: DaemonConfiguration.Agent
        var state = AgentState()
        var output = TaskOutput()
        var artifacts: RunArtifacts?
        var completionOverride: CompletionStatus?
        var serverClosed = false
        var resetRequested = false
    }
    private let configuration: DaemonConfiguration
    private let paths: TaskSquadPaths
    private let api: WorkerAPI
    private let tokens: any TokenProvider
    private let environment: [String: String]
    private let onError: @Sendable (String) -> Void
    private var agents: [String: AgentRuntime] = [:]
    private var order: [String] = []
    private var tasks: [String: Task<Void, Never>] = [:]
    private var daemonLock: DaemonLock?
    private var poller: BatchPoller?
    private var startedAt = ContinuousClock.now
    private var running = false
    private var stopping = false

    public init(configuration: DaemonConfiguration, paths: TaskSquadPaths = .init(),
                tokens: (any TokenProvider)? = nil, transport: any HTTPTransport = NativeHTTPTransport(),
                environment: [String: String] = ProcessInfo.processInfo.environment,
                onError: @escaping @Sendable (String) -> Void = { _ in }) {
        self.configuration = configuration; self.paths = paths
        api = WorkerAPI(baseURL: configuration.server.url, transport: transport)
        self.tokens = tokens ?? Authentication(transport: transport, apiURL: configuration.server.url, firebaseAPIKey: configuration.firebase.apiKey)
        self.environment = environment; self.onError = onError
    }

    public func start() async throws {
        guard !running, !stopping else { return }
        let unsupported = configuration.agents.filter { $0.provider.lowercased() != "stdout" }
        guard unsupported.isEmpty else {
            throw ConfigurationError("This development engine currently supports explicit stdout providers. Pending native provider integrations: " + unsupported.map(\.name).joined(separator: ", "))
        }
        // Go's config.Load accepts duplicate agent IDs (however confusingly), so
        // DaemonConfiguration.parse doesn't reject them either — but this engine's
        // own agent dictionary requires unique keys: Dictionary(uniqueKeysWithValues:)
        // below would trap on a duplicate rather than fail gracefully.
        guard Set(configuration.agents.map(\.id)).count == configuration.agents.count else {
            throw ConfigurationError("Each configured agent must have a unique ID")
        }
        // Acquire before any authentication, heartbeat or task side effect.
        daemonLock = try DaemonLock(paths: paths)
        running = true
        startedAt = .now
        agents = Dictionary(uniqueKeysWithValues: configuration.agents.map { ($0.id, AgentRuntime(configuration: $0)) })
        order = configuration.agents.map(\.id)
        let poller = BatchPoller(api: api, tokens: tokens, pollInterval: configuration.server.pollInterval,
            entries: { [weak self] in await self?.heartbeatEntries() ?? [] },
            receive: { [weak self] response in await self?.receive(response) },
            onError: { [weak self] error in await self?.report(error) })
        self.poller = poller
        await poller.start()
    }

    public func stop() async {
        guard running, !stopping else { return }
        stopping = true; running = false
        await poller?.stop(); poller = nil
        let active = Array(tasks.values)
        for task in active { task.cancel() }
        for task in active { await task.value }
        tasks.removeAll()
        daemonLock = nil
        stopping = false
    }

    public func cancelAgent(_ id: String) async {
        guard let task = tasks[id] else { return }
        agents[id]?.completionOverride = .cancelled
        task.cancel()
        await task.value
    }

    public func forcePoll() async { await poller?.forcePoll() }
    public func snapshots() -> [AgentSnapshot] {
        order.compactMap { id in
            guard let agent = agents[id] else { return nil }
            return AgentSnapshot(id: id, name: agent.configuration.name, mode: agent.state.mode,
                                 taskID: agent.state.taskID, sessionID: agent.state.sessionID)
        }
    }
    private func heartbeatEntries() -> [JSONValue] {
        guard running else { return [] }
        let uptime = startedAt.duration(to: .now).components
        let milliseconds = uptime.seconds * 1000 + uptime.attoseconds / 1_000_000_000_000_000
        return order.compactMap { id in agents[id]?.state.heartbeat(agentID: id, uptimeMilliseconds: milliseconds) }
    }
    private func receive(_ response: [JSONValue]) {
        guard running else { return }
        for item in response {
            // Correlate by the server's own agent_id, not array position: every
            // response entry already carries it, and matching by index instead
            // would misroute a task/reset/cancel to the wrong agent the moment
            // any entry is ever dropped, reordered, or missing.
            guard let id = item["agent_id"]?.string, let agent = agents[id] else { continue }
            if item["reset"] == .bool(true) || item["close"] == .bool(true) {
                agents[id]?.serverClosed = true
                agents[id]?.resetRequested = item["reset"] == .bool(true)
                if tasks[id] == nil { agents[id]?.state.reset() }
                tasks[id]?.cancel()
                continue
            }
            if item["cancel"] == .bool(true) {
                agents[id]?.completionOverride = .cancelled
                tasks[id]?.cancel()
                continue
            }
            if agent.state.mode == .idle, let task = item["task"], task.object != nil {
                beginTask(agentID: id, task: task, memoryRollup: item["memory_rollup"]?.string ?? "")
            }
        }
    }

    private func beginTask(agentID: String, task: JSONValue, memoryRollup: String) {
        guard let taskID = task["id"]?.string, !taskID.isEmpty else { return }
        do {
            guard let generation = try agents[agentID]?.state.beginTask(taskID) else { return }
            agents[agentID]?.output = TaskOutput()
            agents[agentID]?.completionOverride = nil
            agents[agentID]?.serverClosed = false
            agents[agentID]?.resetRequested = false
            tasks[agentID] = Task { await self.execute(agentID: agentID, task: task, memoryRollup: memoryRollup, generation: generation) }
        } catch { report(error) }
    }

    private func execute(agentID: String, task: JSONValue, memoryRollup: String, generation: UInt64) async {
        guard let agent = agents[agentID] else { return }
        let taskID = task["id"]?.string ?? "", subject = task["subject"]?.string ?? ""
        var artifacts: RunArtifacts?
        var status = CompletionStatus.crashed
        do {
            artifacts = try RunArtifacts(paths: paths, agentName: agent.configuration.name, taskID: taskID)
            agents[agentID]?.artifacts = artifacts
            try await artifacts?.writeLines(["# TaskSquad run log", "# agent=\(agent.configuration.name)  task_id=\(taskID)  subject=\(subject)", ""])
            let opened = try await post(agentID: agentID, path: "/daemon/session/open", body: .object(["task_id": .string(taskID)]))
            guard let sessionID = opened["session_id"]?.string, !sessionID.isEmpty else { throw ConfigurationError("Session open response missing session_id") }
            guard agents[agentID]?.state.openedSession(sessionID, generation: generation) == true else { throw CancellationError() }
            try await artifacts?.event(["type": .string("task_start"), "task_id": .string(taskID), "agent": .string(agent.configuration.name),
                "agent_id": .string(agentID), "session_id": .string(sessionID), "subject": .string(subject), "log_path": .string(artifacts?.logURL.path ?? "")])
            let messages = task["messages"]?.array ?? []
            for message in messages {
                try await artifacts?.event(["type": .string("message"), "role": .string(message["role"]?.string ?? ""), "body": .string(message["body"]?.string ?? "")])
            }
            let prompt = TaskPrompt.build(subject: subject, messages: messages, memoryRollup: memoryRollup)
            let parts = agent.configuration.command.split(whereSeparator: \.isWhitespace).map(String.init)
            guard let executable = parts.first else { throw ConfigurationError("Agent command is empty") }
            var environment = environment
            environment["TSQ_TASK_ID"] = taskID
            let process = ProcessSpecification(executable: executable, arguments: Array(parts.dropFirst()) + ["-p", prompt],
                directory: agent.configuration.workDir, environment: environment)
            let result = try await NativeProcess.run(process) { [weak self] channel, data in
                if case .stdout = channel { try await self?.output(agentID: agentID, generation: generation, data: data) }
            }
            status = result.code == 0 ? .closed : .crashed
        } catch is CancellationError { status = .cancelled }
        catch { if Task.isCancelled { status = .cancelled } else { report(error) } }
        // Cleanup is an uncancelled task so cancellation still closes the server
        // session and flushes artifacts. stop() waits for this cleanup to finish.
        let cleanup = Task { await self.complete(agentID: agentID, generation: generation, status: status) }
        await cleanup.value
        try? await artifacts?.close()
        if agents[agentID]?.state.generation == generation { tasks[agentID] = nil; agents[agentID]?.artifacts = nil }
    }

    private func output(agentID: String, generation: UInt64, data: Data) async throws {
        guard agents[agentID]?.state.generation == generation else { return }
        let lines = try agents[agentID]?.output.append(data) ?? []
        try await agents[agentID]?.artifacts?.writeLines(lines)
    }

    private func complete(agentID: String, generation: UInt64, status: CompletionStatus) async {
        guard agents[agentID]?.state.generation == generation else { return }
        let tail = agents[agentID]?.output.finish() ?? []
        try? await agents[agentID]?.artifacts?.writeLines(tail)
        if agents[agentID]?.serverClosed == true {
            if agents[agentID]?.resetRequested != true {
                try? await agents[agentID]?.artifacts?.writeLines(["[EVENT] event=closed_by_user"])
            }
            try? await agents[agentID]?.artifacts?.close()
            agents[agentID]?.artifacts = nil
            tasks[agentID] = nil
            if agents[agentID]?.resetRequested == true { agents[agentID]?.state.reset() }
            else { agents[agentID]?.state.finishCompletion(generation: generation) }
            return // The server already closed this session; do not post a second reply.
        }
        guard agents[agentID]?.state.beginCompletion(generation: generation) == true, let agent = agents[agentID] else {
            try? agents[agentID]?.state.transition(.spawnFailed)
            return
        }
        let status = agent.completionOverride ?? status
        let sessionID = agent.state.sessionID
        do {
            _ = try await post(agentID: agentID, path: "/daemon/session/close", body: .object([
                "session_id": .string(sessionID), "agent_id": .string(agentID),
                "status": .string(status.rawValue), "final_text": .string(agent.output.finalText),
            ]))
        } catch { report(error) }
        do {
            try await ArtifactUploader(api: api, tokens: tokens, agentID: agentID)
                .attachLog(sessionID: sessionID, content: agent.output.logContent)
        } catch { report(error) }
        try? await agent.artifacts?.event(["type": .string("task_end"), "status": .string(status.rawValue), "final_text": .string(agent.output.finalText)])
        agents[agentID]?.state.finishCompletion(generation: generation)
    }

    private func post(agentID: String, path: String, body: JSONValue) async throws -> JSONValue {
        let token = try await tokens.token(forceRotation: false)
        let response = try await api.send(path: path, token: token, agentID: agentID, body: body)
        return response.data.isEmpty ? .object([:]) : try JSONDecoder().decode(JSONValue.self, from: response.data)
    }
    private func report(_ error: Error) { onError(error.localizedDescription) }
}

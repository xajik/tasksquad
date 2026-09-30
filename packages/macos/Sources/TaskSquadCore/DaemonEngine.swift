import Foundation

public struct AgentSnapshot: Sendable, Identifiable {
    public let id: String
    public let name: String
    public let mode: AgentMode
    public let taskID: String
    public let sessionID: String
}

public actor DaemonEngine {
    private struct AgentRuntime {
        let configuration: DaemonConfiguration.Agent
        let provider: ProviderKind
        var state = AgentState()
        var output = TaskOutput()
        var artifacts: RunArtifacts?
        var completionOverride: CompletionStatus?
        var serverClosed = false
        var resetRequested = false
        /// Server auto-closed after a paused reply: reset without posting a close.
        var autoClosed = false
        /// A hook, cancel or terminal close has claimed this task's completion.
        var completionRequested = false
        var tmux: TmuxTaskSession?
        var hookMessage = ""
        var transcriptPath = ""
        var terminalCapture = ""
        var lastPrompt = ""
        var codexThread = ""
        var codexTurns: Set<String> = []
        /// Last bytes a pipe provider wrote to stderr; explains a failed exit.
        var stderrTail = Data()
        init(configuration: DaemonConfiguration.Agent) {
            self.configuration = configuration
            provider = ProviderKind.detect(command: configuration.command, override: configuration.provider)
        }
    }
    private let configuration: DaemonConfiguration
    private let paths: TaskSquadPaths
    private let api: WorkerAPI
    private let tokens: any TokenProvider
    private let environment: [String: String]
    private let tmux: TmuxConnection
    private let timing: InteractiveTiming
    private let onError: @Sendable (String) -> Void
    private var agents: [String: AgentRuntime] = [:]
    private var order: [String] = []
    private var tasks: [String: Task<Void, Never>] = [:]
    private var daemonLock: DaemonLock?
    private var poller: BatchPoller?
    private var portals: PortalHost?
    private var portalTasks: [String: Task<Void, Never>] = [:]
    private var resourceSync: ResourceSync?
    private var hookServer: LocalHTTPServer?
    private var startedAt = ContinuousClock.now
    private var running = false
    private var stopping = false

    public init(configuration: DaemonConfiguration, paths: TaskSquadPaths = .init(),
                tokens: (any TokenProvider)? = nil, transport: any HTTPTransport = NativeHTTPTransport(),
                environment: [String: String] = ProcessInfo.processInfo.environment,
                tmux: TmuxConnection = TmuxConnection(), timing: InteractiveTiming = InteractiveTiming(),
                onError: @escaping @Sendable (String) -> Void = { _ in }) {
        self.configuration = configuration; self.paths = paths
        api = WorkerAPI(baseURL: configuration.server.url, transport: transport)
        self.tokens = tokens ?? Authentication(transport: transport, apiURL: configuration.server.url, firebaseAPIKey: configuration.firebase.apiKey)
        self.environment = environment; self.tmux = tmux; self.timing = timing; self.onError = onError
    }

    public func start() async throws {
        guard !running, !stopping else { return }
        guard Set(configuration.agents.map(\.id)).count == configuration.agents.count else {
            throw ConfigurationError("Each configured agent must have a unique ID")
        }
        let lock = try DaemonLock(paths: paths)
        let runtimes = configuration.agents.map { AgentRuntime(configuration: $0) }
        // Stdout-only configurations have no hook traffic and need no listener.
        if runtimes.contains(where: { $0.provider.usesHooks }) {
            guard let port = UInt16(exactly: configuration.hooks.port), port > 0 else {
                throw ConfigurationError("hooks.port must be between 1 and 65535")
            }
            let server = try LocalHTTPServer(port: port) { [weak self] request in
                await self?.handleHook(request) ?? .init(status: 503)
            }
            do { _ = try await server.start() } catch {
                throw ConfigurationError("Could not listen for provider hooks on 127.0.0.1:\(port): \(error.localizedDescription). Quit any other TaskSquad daemon using this port.")
            }
            hookServer = server
        }
        daemonLock = lock
        running = true
        startedAt = .now
        agents = Dictionary(uniqueKeysWithValues: runtimes.map { ($0.configuration.id, $0) })
        order = configuration.agents.map(\.id)
        let poller = BatchPoller(api: api, tokens: tokens, pollInterval: configuration.server.pollInterval,
            entries: { [weak self] in await self?.heartbeatEntries() ?? [] },
            receive: { [weak self] response in await self?.receive(response) },
            onError: { [weak self] error in self?.report(error) })
        self.poller = poller
        portals = PortalHost(serverURL: configuration.server.url, tmux: tmux, environment: environment, timing: timing, tokens: tokens,
            post: { [weak self] agentID, path, body in
                guard let self else { throw CancellationError() }
                return try await self.post(agentID: agentID, path: path, body: body)
            },
            log: { [weak self] message in self?.onError(message) })
        await poller.start()
        // Server-managed skills, sub-agents and commands (Go: skills/agents/commands StartSync).
        let sync = ResourceSync(api: api, tokens: tokens, paths: paths, agents: configuration.agents) { [weak self] message in self?.onError(message) }
        resourceSync = sync
        await sync.start()
    }

    public func stop() async {
        guard running, !stopping else { return }
        stopping = true; running = false
        await poller?.stop(); poller = nil
        await resourceSync?.stop(); resourceSync = nil
        // Close live portals so their tmux sessions and relay sockets don't
        // outlive the engine (Go: CloseActivePortal on shutdown).
        await portals?.closeAll()
        for task in portalTasks.values { await task.value }
        portalTasks.removeAll(); portals = nil
        let active = Array(tasks.values)
        for task in active { task.cancel() }
        for task in active { await task.value }
        tasks.removeAll()
        await hookServer?.stop(); hookServer = nil
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
    /// Re-syncs skills, sub-agents and commands now (Go: Syncer.ForceSync).
    public func forceResourceSync() async { await resourceSync?.forceSync() }
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
            guard let id = item["agent_id"]?.string, let agent = agents[id] else { continue }
            if item["reset"] == .bool(true) || item["close"] == .bool(true) {
                agents[id]?.serverClosed = true
                agents[id]?.resetRequested = item["reset"] == .bool(true)
                if tasks[id] == nil { agents[id]?.state.reset() }
                tasks[id]?.cancel()
                continue
            }
            // Browser closed the portal or the server detected a crash; with no
            // live session here, report it closed so the server marks it terminal.
            if let close = item["close_portal"], let portalID = close["id"]?.string, !portalID.isEmpty, let portals {
                let crashed = close["crashed"] == .bool(true)
                Task {
                    if await !portals.close(portalID: portalID) {
                        await portals.reportClosed(agentID: id, portalID: portalID, crashed: crashed)
                    }
                }
            }
            let mode = agent.state.mode
            // Portals are assigned to idle agents only, ahead of task pickup as in Go.
            if mode == .idle, portalTasks[id] == nil, let portalID = item["portal"]?["id"]?.string, !portalID.isEmpty {
                startPortal(agentID: id, portalID: portalID)
            }
            if mode == .running || mode == .waitingInput {
                if item["cancel"] == .bool(true) {
                    Task { await self.requestCompletion(agentID: id, status: .cancelled) }
                    continue
                }
                if mode == .waitingInput, let steps = item["close_steps"]?.array?.compactMap({ $0.string }).filter({ !$0.isEmpty }), !steps.isEmpty {
                    startCloseSequence(agentID: id, steps: steps)
                    continue
                }
            }
            if mode == .waitingInput {
                if let reply = item["reply"]?.string, !reply.isEmpty { deliverReply(agentID: id, reply: reply) }
                continue // never pick up a new task while the session is still open
            }
            if mode == .idle, let task = item["task"], task.object != nil {
                beginTask(agentID: id, task: task, memoryRollup: item["memory_rollup"]?.string ?? "")
            }
        }
    }

    private func startPortal(agentID: String, portalID: String) {
        guard let portals, let agent = agents[agentID]?.configuration else { return }
        agents[agentID]?.state.portalActive = true
        portalTasks[agentID] = Task {
            await portals.run(portalID: portalID, agent: agent, directory: agent.workDir)
            self.portalFinished(agentID: agentID)
        }
    }
    private func portalFinished(agentID: String) {
        agents[agentID]?.state.portalActive = false
        portalTasks[agentID] = nil
    }

    private func beginTask(agentID: String, task: JSONValue, memoryRollup: String) {
        guard let taskID = task["id"]?.string, !taskID.isEmpty else { return }
        do {
            guard let generation = try agents[agentID]?.state.beginTask(taskID) else { return }
            agents[agentID]?.output = TaskOutput()
            agents[agentID]?.completionOverride = nil
            agents[agentID]?.serverClosed = false
            agents[agentID]?.resetRequested = false
            agents[agentID]?.autoClosed = false
            agents[agentID]?.completionRequested = false
            agents[agentID]?.tmux = nil
            agents[agentID]?.hookMessage = ""
            agents[agentID]?.transcriptPath = ""
            agents[agentID]?.terminalCapture = ""
            agents[agentID]?.lastPrompt = ""
            agents[agentID]?.codexThread = ""
            agents[agentID]?.codexTurns = []
            agents[agentID]?.stderrTail = Data()
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
            let provider = agent.provider
            if provider.usesHooks {
                do { try provider.setup(workDir: agent.configuration.workDir, hooksPort: configuration.hooks.port, agentID: agentID, taskID: taskID) }
                catch { report(ConfigurationError("[\(agent.configuration.name)] Provider setup warning: \(error.localizedDescription)")) }
            }
            let prompt = Self.injectKBNote(TaskPrompt.build(subject: subject, messages: messages, memoryRollup: memoryRollup),
                                           workDir: agent.configuration.workDir)
            agents[agentID]?.lastPrompt = prompt
            let parts = agent.configuration.command.split(whereSeparator: \.isWhitespace).map(String.init)
            guard let executable = parts.first else { throw ConfigurationError("Agent command is empty") }
            let arguments = Array(parts.dropFirst()) + provider.extraArguments
                + (try provider.setupArguments(hooksPort: configuration.hooks.port, agentID: agentID, taskID: taskID))
            var environment = environment
            environment["TSQ_TASK_ID"] = taskID
            environment.merge(provider.environment) { _, new in new }
            if provider.interactive {
                status = try await runInteractive(agentID: agentID, generation: generation, sessionID: sessionID,
                    command: [executable] + arguments, prompt: prompt, environment: environment, artifacts: artifacts)
            } else {
                let process = ProcessSpecification(executable: executable, arguments: arguments + ["-p", prompt],
                    directory: agent.configuration.workDir, environment: environment)
                try await artifacts?.writeLines(["[EVENT] event=running via=pipe"])
                let result = try await NativeProcess.run(process) { [weak self] channel, data in
                    switch channel {
                    case .stdout: try await self?.output(agentID: agentID, generation: generation, data: data)
                    case .stderr: await self?.recordStderr(agentID: agentID, generation: generation, data: data)
                    }
                }
                status = result.code == 0 ? .closed : .crashed
            }
        } catch is CancellationError { status = .cancelled }
        catch { if Task.isCancelled { status = .cancelled } else { report(error) } }
        let cleanup = Task { await self.complete(agentID: agentID, generation: generation, status: status) }
        await cleanup.value
        try? await artifacts?.close()
        if agents[agentID]?.state.generation == generation { tasks[agentID] = nil; agents[agentID]?.artifacts = nil }
    }

    /// Ports the tmux branch of agent/lifecycle.go startTask: the CLI runs in a
    /// detached tmux session, its pane is piped through a FIFO, and the prompt is
    /// typed once the TUI is ready. Returns when the session ends.
    private func runInteractive(agentID: String, generation: UInt64, sessionID: String, command: [String], prompt: String,
                                environment: [String: String], artifacts: RunArtifacts?) async throws -> CompletionStatus {
        guard let agent = agents[agentID] else { throw CancellationError() }
        let provider = agent.provider
        guard ExecutableLocator.find(tmux.executable, environment: environment) != nil else {
            throw ConfigurationError("[\(agent.configuration.name)] tmux is required but not found — cannot start task")
        }
        let session = try TmuxTaskSession(tmux: tmux, sessionID: sessionID)
        let formatted = provider.formatPrompt(prompt)
        var sessionEnvironment = provider.environment
        sessionEnvironment["TSQ_TASK_ID"] = environment["TSQ_TASK_ID"]
        // An already-running tmux server would otherwise supply its own PATH.
        if let path = environment["PATH"] { sessionEnvironment["PATH"] = path }
        try await session.start(command: command + provider.initialPromptArguments(formatted),
                                directory: agent.configuration.workDir, environment: sessionEnvironment)
        let stream: AsyncStream<Data>
        do { stream = try await session.pipeOutput(timeout: timing.fifoOpenTimeout) }
        catch {
            await session.kill(); session.removeFIFO()
            throw ConfigurationError("[\(agent.configuration.name)] FIFO open failed — cannot start task: \(error.localizedDescription)")
        }
        defer { session.removeFIFO() }
        guard agents[agentID]?.state.generation == generation else { await session.kill(); throw CancellationError() }
        agents[agentID]?.tmux = session
        try? await artifacts?.writeLines(["[EVENT] event=running via=tmux session=\(session.name)"])
        let reader = Task {
            for await chunk in stream {
                do { try await self.output(agentID: agentID, generation: generation, data: chunk) }
                catch { self.report(error) }
            }
        }
        await withTaskCancellationHandler {
            if !provider.promptInArguments {
                do {
                    try await Task.sleep(for: timing.readyWait)
                    try await session.sendText(formatted, timing: timing)
                } catch is CancellationError { }
                catch { report(ConfigurationError("[\(agent.configuration.name)] Could not type prompt into tmux: \(error.localizedDescription)")) }
            }
            await reader.value
        } onCancel: {
            Task { await session.kill() }
        }
        if agents[agentID]?.state.generation == generation { agents[agentID]?.tmux = nil }
        if Task.isCancelled { return .cancelled }
        // A session that ends without a completion hook is a crash (Go: tmux EOF path).
        return provider.usesHooks ? .crashed : .closed
    }

    private func output(agentID: String, generation: UInt64, data: Data) async throws {
        guard agents[agentID]?.state.generation == generation else { return }
        let lines = try agents[agentID]?.output.append(data) ?? []
        try await agents[agentID]?.artifacts?.writeLines(lines)
    }

    private func recordStderr(agentID: String, generation: UInt64, data: Data) {
        guard agents[agentID]?.state.generation == generation, var tail = agents[agentID]?.stderrTail else { return }
        tail.append(data)
        agents[agentID]?.stderrTail = tail.suffix(8 * 1024)
    }

    private func complete(agentID: String, generation: UInt64, status: CompletionStatus) async {
        guard agents[agentID]?.state.generation == generation else { return }
        let tail = agents[agentID]?.output.finish() ?? []
        try? await agents[agentID]?.artifacts?.writeLines(tail)
        if agents[agentID]?.serverClosed == true || agents[agentID]?.autoClosed == true {
            let reset = agents[agentID]?.resetRequested == true || agents[agentID]?.autoClosed == true
            if agents[agentID]?.autoClosed == true {
                try? await agents[agentID]?.artifacts?.writeLines(["[EVENT] event=success"])
            } else if agents[agentID]?.resetRequested != true {
                try? await agents[agentID]?.artifacts?.writeLines(["[EVENT] event=closed_by_user"])
            }
            try? await agents[agentID]?.artifacts?.close()
            agents[agentID]?.artifacts = nil
            tasks[agentID] = nil
            if reset { agents[agentID]?.state.reset() }
            else { agents[agentID]?.state.finishCompletion(generation: generation) }
            return // The server already closed this session; do not post a second reply.
        }
        let wasLearning = agents[agentID]?.state.mode == .learning
        guard agents[agentID]?.state.beginCompletion(generation: generation) == true, let agent = agents[agentID] else {
            try? agents[agentID]?.state.transition(.spawnFailed)
            return
        }
        // A pipe provider's own non-zero exit outranks a completion hook: Pi fires
        // agent_end even when its model call failed (Go reports that as success).
        let exitFailed = !agent.provider.interactive && status == .crashed
        let status = exitFailed && agent.completionOverride == .closed ? .crashed : (agent.completionOverride ?? status)
        let sessionID = agent.state.sessionID
        let capture = agent.terminalCapture
        var finalText = wasLearning ? "" : await Self.finalText(hookMessage: agent.hookMessage, provider: agent.provider,
            transcriptPath: agent.transcriptPath, capture: capture, output: agent.output)
        if finalText.isEmpty && status == .crashed && !agent.stderrTail.isEmpty {
            let lines = String(decoding: agent.stderrTail, as: UTF8.self).components(separatedBy: "\n")
                .map(TaskOutput.cleanLine).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            finalText = "Agent process failed:\n" + lines.suffix(40).joined(separator: "\n")
            try? await agent.artifacts?.writeLines(["", "# --- stderr ---"] + lines)
        }
        try? await agent.artifacts?.writeLines(status == .closed ? ["", "[EVENT] event=success"] : ["", "[EVENT] event=failure status=\(status.rawValue)"])
        if !capture.isEmpty { try? await agent.artifacts?.writeLines(["", "# --- terminal scrollback ---", capture]) }
        var messageID = ""
        do {
            let response = try await post(agentID: agentID, path: "/daemon/session/close", body: .object([
                "session_id": .string(sessionID), "agent_id": .string(agentID),
                "status": .string(status.rawValue), "final_text": .string(finalText),
            ]))
            messageID = response["message_id"]?.string ?? ""
        } catch { report(error) }
        let uploader = ArtifactUploader(api: api, tokens: tokens, agentID: agentID)
        do { try await uploader.attachLog(sessionID: sessionID, content: capture.isEmpty ? agent.output.logContent : capture) }
        catch { report(error) }
        await attachTranscript(uploader: uploader, sessionID: sessionID, messageID: messageID,
                               transcriptPath: agent.transcriptPath, capture: capture)
        try? await agent.artifacts?.event(["type": .string("task_end"), "status": .string(status.rawValue), "final_text": .string(finalText)])
        agents[agentID]?.state.finishCompletion(generation: generation)
    }

    // MARK: Hook-driven lifecycle (agent/session.go)

    /// Go's Complete/completeScoped: claims completion, captures the terminal, then
    /// ends the session so the FIFO drains and `execute` posts the close.
    @discardableResult
    private func requestCompletion(agentID: String, status: CompletionStatus, transcriptPath: String = "",
                                   expectedTask: String? = nil, expectedSession: String? = nil) async -> Bool {
        guard let agent = agents[agentID], !agent.completionRequested, !agent.state.completing, !agent.state.sessionID.isEmpty,
              expectedTask.map({ $0 == agent.state.taskID }) ?? true,
              expectedSession.map({ $0 == agent.tmux?.name }) ?? true else { return false }
        let generation = agent.state.generation
        agents[agentID]?.completionRequested = true
        agents[agentID]?.completionOverride = status
        if !transcriptPath.isEmpty { agents[agentID]?.transcriptPath = transcriptPath }
        if let session = agent.tmux {
            let capture = await session.capture()
            if agents[agentID]?.state.generation == generation { agents[agentID]?.terminalCapture = capture }
            await session.kill()
        } else if status == .cancelled {
            tasks[agentID]?.cancel()
        } else {
            // Pipe providers (Pi) exit on their own after the hook; bound the wait.
            let grace = timing.pipeExitGrace
            Task {
                try? await Task.sleep(for: grace)
                await self.cancelIfStillRunning(agentID: agentID, generation: generation)
            }
        }
        return true
    }

    private func cancelIfStillRunning(agentID: String, generation: UInt64) {
        guard agents[agentID]?.state.generation == generation else { return }
        tasks[agentID]?.cancel()
    }

    /// Go's StopAndPause: posts this turn's reply and keeps the session open for a follow-up.
    private func pause(agentID: String, hookMessage: String, transcriptPath: String, fallback: String? = nil) async {
        guard let agent = agents[agentID], !agent.completionRequested else { return }
        let generation = agent.state.generation
        guard agents[agentID]?.state.claimNotification(generation: generation) == true else { return }
        try? await Task.sleep(for: .milliseconds(300)) // let the FIFO drain
        let capture = await agent.tmux?.capture() ?? ""
        guard let current = agents[agentID], current.state.generation == generation else { return }
        var text = hookMessage.isEmpty ? await Self.transcriptText(provider: agent.provider, path: transcriptPath) : hookMessage
        if text.isEmpty, let fallback { text = Self.notifyMessage(capture: capture, prompt: current.lastPrompt, fallback: fallback) }
        if text.isEmpty { text = Self.tail(capture) }
        if text.isEmpty { text = current.output.finalText }
        let sessionID = current.state.sessionID
        var response: JSONValue?
        do {
            response = try await post(agentID: agentID, path: "/daemon/session/notify", body: .object([
                "session_id": .string(sessionID), "agent_id": .string(agentID), "message": .string(text),
            ]))
        } catch { report(error) }
        // A close/reset may have won while the notify request was in flight.
        guard let latest = agents[agentID], latest.state.generation == generation, !latest.completionRequested, !latest.state.completing else { return }
        try? await latest.artifacts?.event(["type": .string("agent_turn"), "body": .string(text), "transcript_path": .string(transcriptPath)])
        let uploader = ArtifactUploader(api: api, tokens: tokens, agentID: agentID)
        let log = capture.isEmpty ? latest.output.logContent : capture
        Task {
            await self.attachTranscript(uploader: uploader, sessionID: sessionID, messageID: response?["message_id"]?.string ?? "",
                                        transcriptPath: transcriptPath, capture: capture)
            do { try await uploader.attachLog(sessionID: sessionID, content: log) } catch { self.report(error) }
        }
        if response?["close"] == .bool(true) {
            agents[agentID]?.autoClosed = true
            if let session = latest.tmux { await session.kill() } else { tasks[agentID]?.cancel() }
            return
        }
        if !transcriptPath.isEmpty { agents[agentID]?.transcriptPath = transcriptPath }
        if agents[agentID]?.state.mode == .running { try? agents[agentID]?.state.transition(.hookStop) }
    }

    /// Gemini AfterAgent: posts a per-turn message without changing mode.
    private func pushIntermediate(agentID: String, response: String, transcriptPath: String) async {
        guard let agent = agents[agentID], agent.state.mode == .running || agent.state.mode == .waitingInput else { return }
        let text = response.isEmpty ? await Self.transcriptText(provider: agent.provider, path: transcriptPath, retry: false) : response
        guard !text.isEmpty else { return }
        do {
            let result = try await post(agentID: agentID, path: "/daemon/session/message", body: .object([
                "session_id": .string(agent.state.sessionID), "type": .string("output"), "message": .string(text),
            ]))
            if result["close"] == .bool(true), agents[agentID]?.state.generation == agent.state.generation {
                agents[agentID]?.autoClosed = true
                if let session = agents[agentID]?.tmux { await session.kill() }
            }
        } catch { report(error) }
    }

    private func deliverReply(agentID: String, reply: String) {
        guard let agent = agents[agentID], let session = agent.tmux else { return }
        // Transition before typing so a repeated heartbeat cannot deliver it twice.
        do { try agents[agentID]?.state.userReplied() } catch { report(error); return }
        agents[agentID]?.lastPrompt = reply
        let provider = agent.provider, timing = timing, artifacts = agent.artifacts
        Task {
            try? await artifacts?.event(["type": .string("user_reply"), "body": .string(reply)])
            do {
                try await Task.sleep(for: timing.replyDelay)
                try await self.type(provider.formatPrompt(reply), into: session, provider: provider)
            } catch { self.report(error) }
        }
    }

    private func startCloseSequence(agentID: String, steps: [String]) {
        do { try agents[agentID]?.state.transition(.learnStart) } catch { report(error); return }
        agents[agentID]?.state.pendingSteps = steps
        agents[agentID]?.state.executedSteps = []
        guard agents[agentID]?.tmux != nil else {
            Task { await self.requestCompletion(agentID: agentID, status: .closed) }
            return
        }
        injectNextStep(agentID: agentID)
    }

    private func advanceCloseStep(agentID: String) async {
        guard var state = agents[agentID]?.state else { return }
        if !state.pendingSteps.isEmpty { state.executedSteps.append(state.pendingSteps.removeFirst()) }
        agents[agentID]?.state.pendingSteps = state.pendingSteps
        agents[agentID]?.state.executedSteps = state.executedSteps
        if state.pendingSteps.isEmpty { await requestCompletion(agentID: agentID, status: .closed) }
        else { injectNextStep(agentID: agentID) }
    }

    private func injectNextStep(agentID: String) {
        guard let agent = agents[agentID], let step = agent.state.pendingSteps.first, let session = agent.tmux else { return }
        let provider = agent.provider
        Task {
            do {
                try await Task.sleep(for: .milliseconds(500))
                try await self.type(provider.formatPrompt(step), into: session, provider: provider)
            } catch { self.report(error) }
        }
    }

    /// Codex rewrites TaskSquad's `/tsq-x` skill calls to `$tsq-x` anywhere after whitespace.
    static func opensCodexSkillPicker(_ text: String) -> Bool {
        text.range(of: #"(^|\s)\$tsq-[A-Za-z0-9_-]+"#, options: .regularExpression) != nil
    }

    private nonisolated func type(_ text: String, into session: TmuxTaskSession, provider: ProviderKind) async throws {
        if provider == .codex {
            try await session.pasteText(text, timing: timing)
            // A `$tsq-…` skill token opens Codex's skill picker: the first Enter only
            // selects the skill, the second submits. An Enter on an empty composer is a no-op.
            if Self.opensCodexSkillPicker(text) {
                try await Task.sleep(for: timing.submitWait)
                _ = try await session.tmux.run(["send-keys", "-t", session.name, "C-m"])
            }
        } else { try await session.sendText(text, timing: timing) }
    }

    // MARK: Hook server (hooks/server.go, hooks/handlers.go)

    private func handleHook(_ request: LocalHTTPRequest) async -> LocalHTTPResponse {
        let ok = LocalHTTPResponse.json(.object(["status": .string("ok")]))
        let query = Dictionary((request.components?.queryItems ?? []).map { ($0.name, $0.value ?? "") }) { first, _ in first }
        let agentParam = query["agent"] ?? "", taskParam = query["task_id"] ?? "", providerParam = query["provider"] ?? ""
        switch request.path {
        case "/hooks/stop":
            let event = HookAdapter.parseStop(provider: providerParam, body: request.body, isFailure: query["failure"] == "true")
            await dispatchStop(agentParam: agentParam, taskParam: taskParam, provider: providerParam, event: event)
            return ok
        case "/hooks/codex":
            guard request.method == "POST" else { return .init(status: 405) }
            guard !agentParam.isEmpty, !taskParam.isEmpty else { return .init(status: 400) }
            let payload = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            guard let thread = payload["thread-id"] as? String, !thread.isEmpty else { return .init(status: 400) }
            guard payload["type"] as? String == "agent-turn-complete" else { return .json(.object(["status": .string("ignored")])) }
            guard claimCodexTurn(agentID: agentParam, taskID: taskParam, thread: thread, turn: payload["turn-id"] as? String ?? "") else {
                return .json(.object(["status": .string("ignored")]))
            }
            let event = HookAdapter.parseStop(provider: "codex", body: request.body, isFailure: false)
            await dispatchStop(agentParam: agentParam, taskParam: taskParam, provider: "codex", event: event)
            return ok
        case "/hooks/notification":
            let (message, transcript) = HookAdapter.parseNotification(body: request.body)
            if let id = matchingAgent(agentParam, taskParam), agents[id]?.state.mode == .running {
                Task { await self.pause(agentID: id, hookMessage: "", transcriptPath: transcript,
                                        fallback: message.isEmpty ? "Waiting for your input" : message) }
            }
            return ok
        case "/hooks/after_agent":
            let (response, transcript) = HookAdapter.parseAfterAgent(provider: providerParam, body: request.body)
            if let id = matchingAgent(agentParam, taskParam) {
                Task { await self.pushIntermediate(agentID: id, response: response, transcriptPath: transcript) }
            }
            return ok
        case "/hooks/tui-blocked":
            if let id = matchingAgent(agentParam, taskParam) { agents[id]?.state.setTUIBlocked(query["state"] == "on") }
            Task { await self.forcePoll() }
            return ok
        case "/hooks/opencode":
            return ok
        case "/hooks/terminal/input", "/hooks/terminal/close":
            return await handleTerminal(request)
        case "/hooks/skill":
            return await handleSkill(request, agentParam: agentParam)
        default:
            return .init(status: 404)
        }
    }

    /// POST /hooks/skill: a running session pushes a learned skill (Go: handleSkill).
    /// The pushing agent is the one wrapping up, else the `?agent=` match.
    private func handleSkill(_ request: LocalHTTPRequest, agentParam: String) async -> LocalHTTPResponse {
        guard request.method == "POST" else { return .init(status: 405) }
        guard let payload = try? JSONDecoder().decode(JSONValue.self, from: request.body),
              let name = payload["name"]?.string, !name.isEmpty, let content = payload["content"]?.string, !content.isEmpty
        else { return .init(status: 400, body: Data("invalid payload: name and content required".utf8)) }
        guard name.hasPrefix("tsq-") else { return .init(status: 400, body: Data("skill name must start with tsq-".utf8)) }
        let active = order.first { agents[$0]?.state.mode == .learning } ?? order.first { !agentParam.isEmpty && $0 == agentParam }
        guard let agentID = active else { return .init(status: 404, body: Data("no active agent".utf8)) }
        do {
            let response = try await post(agentID: agentID, path: "/daemon/skills", body: .object([
                "name": .string(name), "description": .string(payload["description"]?.string ?? ""), "content": .string(content)]))
            return .json(response)
        } catch { return .init(status: 502, body: Data("upstream error: \(error.localizedDescription)".utf8)) }
    }

    /// Hooks are routed by agent ID and rejected when their task is stale.
    private func matchingAgent(_ agentParam: String, _ taskParam: String) -> String? {
        order.first { id in
            guard agentParam.isEmpty || id == agentParam, let agent = agents[id] else { return false }
            return taskParam.isEmpty || agent.state.taskID == taskParam
        }
    }

    private func claimCodexTurn(agentID: String, taskID: String, thread: String, turn: String) -> Bool {
        guard let agent = agents[agentID], agent.state.taskID == taskID, agents[agentID]?.state.pinCLISessionID(thread) == true else { return false }
        if agent.codexThread != thread { agents[agentID]?.codexThread = thread; agents[agentID]?.codexTurns = [] }
        if !turn.isEmpty && agents[agentID]?.codexTurns.contains(turn) == true { return false }
        agents[agentID]?.codexTurns.insert(turn)
        return true
    }

    private func dispatchStop(agentParam: String, taskParam: String, provider: String, event: HookStopEvent) async {
        guard let id = matchingAgent(agentParam, taskParam) else { return }
        // Reject hooks from an unrelated CLI process sharing this agent's hook URL.
        guard agents[id]?.state.pinCLISessionID(event.sessionID) == true else { return }
        switch agents[id]?.state.mode {
        case .learning:
            Task { await self.advanceCloseStep(agentID: id) }
        case .running, .waitingInput:
            if event.isFailure {
                Task { await self.requestCompletion(agentID: id, status: .crashed, transcriptPath: event.transcriptPath) }
            } else if provider == "pi" {
                // Pi exits right after agent_end; complete rather than pause.
                agents[id]?.hookMessage = event.hookMessage
                Task { await self.requestCompletion(agentID: id, status: .closed, transcriptPath: event.transcriptPath) }
            } else {
                Task { await self.pause(agentID: id, hookMessage: event.hookMessage, transcriptPath: event.transcriptPath) }
            }
        default:
            break
        }
    }

    private struct TerminalRequest: Decodable {
        let agentID: String, taskID: String, session: String
        let pane: String?, data: Data?, submit: Bool?
        enum CodingKeys: String, CodingKey { case agentID = "agent_id", taskID = "task_id", session, pane, data, submit }
    }

    /// Native-client terminal control; identity is rechecked against the live task.
    private func handleTerminal(_ request: LocalHTTPRequest) async -> LocalHTTPResponse {
        guard request.method == "POST" else { return .init(status: 405) }
        guard request.headers["origin"] == nil, request.headers["content-type"]?.hasPrefix("application/json") == true else {
            return .init(status: 403)
        }
        guard request.body.count <= 16 * 1024, let body = try? JSONDecoder().decode(TerminalRequest.self, from: request.body),
              !body.agentID.isEmpty, !body.taskID.isEmpty, !body.session.isEmpty else { return .init(status: 400) }
        guard agents[body.agentID] != nil else { return .init(status: 404) }
        if request.path == "/hooks/terminal/close" {
            guard await requestCompletion(agentID: body.agentID, status: .closed, expectedTask: body.taskID, expectedSession: body.session)
            else { return .init(status: 409) }
            await forcePoll()
            return .init(status: 204)
        }
        let data = body.data ?? Data(), submit = body.submit ?? false, pane = body.pane ?? ""
        guard !data.isEmpty, data.count <= 4096, !submit || data.contains(10) || data.contains(13) else { return .init(status: 409) }
        func active() -> TmuxTaskSession? {
            guard let agent = agents[body.agentID], agent.state.taskID == body.taskID, !agent.completionRequested, !agent.state.completing,
                  agent.state.mode == .running || agent.state.mode == .waitingInput,
                  let session = agent.tmux, session.name == body.session else { return nil }
            return session
        }
        guard let session = active(), await session.owns(pane: pane) else { return .init(status: 409) }
        do { try await session.sendBytes(data, pane: pane) } catch { return .init(status: 409) }
        if submit, active() != nil, agents[body.agentID]?.state.mode == .waitingInput {
            try? agents[body.agentID]?.state.userReplied()
            await forcePoll()
        }
        return .init(status: 204)
    }

    // MARK: Text extraction

    private static func injectKBNote(_ prompt: String, workDir: String) -> String {
        let root = URL(fileURLWithPath: workDir).appendingPathComponent("tsq/kb", isDirectory: true)
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
        guard files?.contains(where: { ($0 as? URL)?.pathExtension == "md" }) == true else { return prompt }
        return prompt + "\n\n## Knowledge base available\n"
            + "This project has a knowledge base at tsq/kb/. Run `tsq kb search <query>` "
            + "to look up package/API details before exploring the codebase from scratch."
    }

    /// Transcripts are written asynchronously by the CLI; retry briefly while empty.
    private static func transcriptText(provider: ProviderKind, path: String, retry: Bool = true) async -> String {
        guard !path.isEmpty else { return "" }
        let deadline = ContinuousClock.now.advanced(by: .seconds(retry ? 10 : 0))
        while true {
            let text = HookAdapter.extractTranscript(provider: provider, path: path)
            if !text.isEmpty || ContinuousClock.now >= deadline { return text }
            try? await Task.sleep(for: .milliseconds(500))
        }
    }

    private static func finalText(hookMessage: String, provider: ProviderKind, transcriptPath: String,
                                  capture: String, output: TaskOutput) async -> String {
        if !hookMessage.isEmpty { return hookMessage }
        let transcript = await transcriptText(provider: provider, path: transcriptPath)
        if !transcript.isEmpty { return transcript }
        return capture.isEmpty ? output.finalText : capture
    }

    private static func tail(_ text: String) -> String {
        String(decoding: text.utf8.suffix(10_000), as: UTF8.self)
    }

    /// Last visible terminal lines, minus echoes of the prompt (agent/output.go).
    private static func notifyMessage(capture: String, prompt: String, fallback: String) -> String {
        let cleanPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = capture.components(separatedBy: "\n")
            .map { TaskOutput.cleanLine($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && (cleanPrompt.isEmpty || (!$0.contains(cleanPrompt) && !cleanPrompt.contains($0))) }
        return lines.isEmpty ? fallback : lines.suffix(15).joined(separator: "\n")
    }

    private func attachTranscript(uploader: ArtifactUploader, sessionID: String, messageID: String,
                                  transcriptPath: String, capture: String) async {
        guard !messageID.isEmpty else { return }
        do {
            if !transcriptPath.isEmpty, let data = FileManager.default.contents(atPath: transcriptPath) {
                try await uploader.attach(sessionID: sessionID, messageID: messageID, filename: "transcript.jsonl", data: data)
            } else if !capture.isEmpty {
                try await uploader.attach(sessionID: sessionID, messageID: messageID, filename: "transcript.txt", data: Data(capture.utf8))
            }
        } catch { report(error) }
    }

    private func post(agentID: String, path: String, body: JSONValue) async throws -> JSONValue {
        let token = try await tokens.token(forceRotation: false)
        let response = try await api.send(path: path, token: token, agentID: agentID, body: body)
        return response.data.isEmpty ? .object([:]) : try JSONDecoder().decode(JSONValue.self, from: response.data)
    }
    private nonisolated func report(_ error: Error) { onError(error.localizedDescription) }
}

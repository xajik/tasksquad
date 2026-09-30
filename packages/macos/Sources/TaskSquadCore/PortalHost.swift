import Foundation

/// Hosts browser Portals: a bare interactive tmux session running the agent's
/// command, streamed to the web app through the TerminalRelay Durable Object.
/// Port of packages/daemon/agent/portal.go and terminal_relay.go; one portal
/// per agent at a time, assigned through the heartbeat batch response.
actor PortalHost {
    typealias Post = @Sendable (_ agentID: String, _ path: String, _ body: JSONValue) async throws -> JSONValue
    private let serverURL: String
    private let tmux: TmuxConnection
    private let environment: [String: String]
    private let timing: InteractiveTiming
    private let tokens: any TokenProvider
    private let post: Post
    /// Failures only: they surface in the app like other engine errors.
    private let log: @Sendable (String) -> Void
    /// Portal ID → its tmux session, for every portal currently live.
    private var active: [String: TmuxTaskSession] = [:]
    private var closing: Set<String> = []

    init(serverURL: String, tmux: TmuxConnection, environment: [String: String], timing: InteractiveTiming,
         tokens: any TokenProvider, post: @escaping Post, log: @escaping @Sendable (String) -> Void) {
        self.serverURL = serverURL; self.tmux = tmux; self.environment = environment; self.timing = timing
        self.tokens = tokens; self.post = post; self.log = log
    }

    func isActive(_ portalID: String) -> Bool { active[portalID] != nil }

    /// Runs one portal to completion. Returns after the session ends and the
    /// server has been told the final status.
    func run(portalID: String, agent: DaemonConfiguration.Agent, directory: String) async {
        guard active[portalID] == nil else { return }
        let session: TmuxTaskSession
        do { session = try TmuxTaskSession(tmux: tmux, portalID: portalID) }
        catch { log("[portal] \(error.localizedDescription)"); await report(agent.id, portalID, "failed"); return }
        active[portalID] = session
        defer { active[portalID] = nil; closing.remove(portalID); session.removeFIFO() }
        NSLog("[%@] portal %@: starting", agent.name, portalID)

        let stream: AsyncStream<Data>
        do {
            try await session.start(command: agent.command.split(whereSeparator: \.isWhitespace).map(String.init),
                                    // An already-running tmux server keeps its own environment,
                                    // so pass PATH explicitly or the agent command may not resolve.
                                    directory: directory, environment: environment["PATH"].map { ["PATH": $0] } ?? [:])
            stream = try await session.pipeOutput(timeout: timing.fifoOpenTimeout)
        } catch {
            log("[portal] start failed for \(portalID): \(error.localizedDescription)")
            await session.kill(); await report(agent.id, portalID, "failed"); return
        }

        // Session ID = portal ID; open sets portals.session_id, which the relay's
        // auth check requires before the daemon may dial it.
        do {
            let opened = try await post(agent.id, "/daemon/portal/open", .object(["portal_id": .string(portalID), "session_id": .string(portalID)]))
            if opened["close_now"] == .bool(true) || closing.contains(portalID) {
                await session.kill(); await report(agent.id, portalID, "done"); return
            }
        } catch {
            log("[portal] open report failed for \(portalID): \(error.localizedDescription)")
            await session.kill(); await report(agent.id, portalID, "failed"); return
        }

        let relay = await dialRelay(agentID: agent.id, sessionID: portalID)
        let input = relay.map { socket in Task { await Self.forwardInput(from: socket, to: session) } }
        var total = 0
        for await chunk in stream {
            total += chunk.count
            // Relay errors are non-fatal, as in Go: the session keeps running.
            try? await relay?.send(.data(chunk))
        }
        input?.cancel()
        relay?.cancel(with: .normalClosure, reason: nil)
        await session.kill()
        NSLog("[portal] %@: stream ended after %d bytes", portalID, total)
        await report(agent.id, portalID, "done")
    }

    /// Browser closed the portal (or the server detected a crash). Returns false
    /// when no portal with that ID is live here, so the caller reports it closed.
    func close(portalID: String) async -> Bool {
        guard let session = active[portalID] else { return false }
        closing.insert(portalID)
        NSLog("[portal] %@: close requested, killing tmux", portalID)
        await session.kill()
        return true
    }

    func closeAll() async {
        for id in Array(active.keys) { _ = await close(portalID: id) }
    }

    /// Crash recovery: no live session, so just mark the portal terminal.
    func reportClosed(agentID: String, portalID: String, crashed: Bool) async {
        await report(agentID, portalID, crashed ? "failed" : "done")
    }

    private func report(_ agentID: String, _ portalID: String, _ status: String) async {
        _ = try? await post(agentID, "/daemon/portal/close", .object(["portal_id": .string(portalID), "status": .string(status)]))
    }

    private func dialRelay(agentID: String, sessionID: String) async -> URLSessionWebSocketTask? {
        guard let token = try? await tokens.token(forceRotation: false),
              let url = URL(string: serverURL.replacingOccurrences(of: "https://", with: "wss://")
                                              .replacingOccurrences(of: "http://", with: "ws://") + "/terminal/" + sessionID) else {
            log("Portal terminal relay unavailable for \(sessionID): no token or invalid server URL"); return nil
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue(agentID, forHTTPHeaderField: "X-TSQ-Agent")
        let socket = URLSession.shared.webSocketTask(with: request)
        socket.resume()
        return socket
    }

    /// Browser frames: `{"t":"i","d":"<base64 stdin>"}` and `{"t":"r","c":cols,"r":rows}`.
    /// Portals have no task mode, so input is always allowed.
    private static func forwardInput(from socket: URLSessionWebSocketTask, to session: TmuxTaskSession) async {
        while !Task.isCancelled {
            guard let message = try? await socket.receive() else { return }
            let data: Data
            switch message {
            case .string(let text): data = Data(text.utf8)
            case .data(let bytes): data = bytes
            @unknown default: continue
            }
            guard let frame = try? JSONDecoder().decode(JSONValue.self, from: data) else { continue }
            switch frame["t"]?.string {
            case "i":
                guard let encoded = frame["d"]?.string, let bytes = Data(base64Encoded: encoded), !bytes.isEmpty else { continue }
                // Hex keys are byte-exact, including UTF-8 split across frames.
                _ = try? await session.tmux.run(["send-keys", "-H", "-t", session.name] + bytes.map { String(format: "%02x", $0) })
            case "r":
                let cols = Int(frame["c"]?.number ?? 0), rows = Int(frame["r"]?.number ?? 0)
                if cols > 0, rows > 0 {
                    _ = try? await session.tmux.run(["resize-window", "-t", session.name, "-x", String(cols), "-y", String(rows)])
                }
            default: continue
            }
        }
    }
}

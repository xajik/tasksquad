import Foundation

public protocol TokenProvider: Sendable {
    func token(forceRotation: Bool) async throws -> String
}
extension Authentication: TokenProvider { }

/// Scheduling policy from agent/batch.go, independent of clocks/network for tests.
public struct BatchTiming: Sendable {
    public private(set) var interval: Duration
    public private(set) var etag = ""
    private var rateLimitSeconds = 0
    public init(pollInterval: Int) { interval = .seconds(pollInterval) }

    public mutating func receive(status: Int, etag newETag: String = "", agents: [JSONValue] = []) -> Duration {
        if status == 429 {
            rateLimitSeconds = min(rateLimitSeconds == 0 ? 30 : rateLimitSeconds * 2, 300)
            return .seconds(rateLimitSeconds)
        }
        if (200..<300).contains(status) || status == 304 {
            rateLimitSeconds = 0
            if status != 304 {
                etag = newETag
                if let milliseconds = agents.first?["next_poll_ms"]?.number, milliseconds > 0, milliseconds.isFinite {
                    interval = .milliseconds(milliseconds)
                }
            }
        }
        return interval
    }
}

public actor BatchPoller {
    public typealias Entries = @Sendable () async -> [JSONValue]
    public typealias Receiver = @Sendable ([JSONValue]) async -> Void
    public typealias ErrorHandler = @Sendable (Error) async -> Void
    private let api: WorkerAPI
    private let tokens: any TokenProvider
    private let entries: Entries
    private let receive: Receiver
    private let onError: ErrorHandler
    /// Go's batch analytics: task_poll_rate_limited, task_poll_auth_failed.
    private let track: @Sendable (String, [String: JSONValue]?) -> Void
    private let initialInterval: Int
    private var timing: BatchTiming
    private var loop: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var trigger: AsyncStream<Void>.Continuation?
    private var generation: UInt64 = 0

    public init(api: WorkerAPI, tokens: any TokenProvider, pollInterval: Int,
                entries: @escaping Entries, receive: @escaping Receiver,
                onError: @escaping ErrorHandler, track: @escaping @Sendable (String, [String: JSONValue]?) -> Void = { _, _ in }) {
        self.api = api; self.tokens = tokens; self.initialInterval = pollInterval; self.track = track
        timing = BatchTiming(pollInterval: pollInterval)
        self.entries = entries; self.receive = receive; self.onError = onError
    }

    public func start() {
        guard loop == nil else { return }
        generation &+= 1
        let expected = generation
        timing = BatchTiming(pollInterval: initialInterval)
        let (events, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        trigger = continuation
        loop = Task { [weak self] in
            for await _ in events {
                guard !Task.isCancelled else { return }
                await self?.cycle(generation: expected)
            }
        }
        continuation.yield()
    }

    public func forcePoll() {
        Log.info("[batch] force-poll triggered")
        trigger?.yield()
    }

    public func stop() async {
        generation &+= 1
        timer?.cancel(); timer = nil
        let current = loop; loop = nil
        current?.cancel()
        trigger?.finish(); trigger = nil
        await current?.value
    }

    private func cycle(generation expected: UInt64) async {
        guard expected == generation, !Task.isCancelled else { return }
        timer?.cancel(); timer = nil
        var next = timing.interval
        var logged = false // Go logs each failure once, with its own wording
        do {
            let token: String
            do { token = try await tokens.token(forceRotation: false) }
            catch { Log.error("[batch] auth error: \(error.localizedDescription)"); logged = true; throw error }
            let list = await entries()
            guard expected == generation, !Task.isCancelled else { return }
            let response: HTTPResult
            do { response = try await api.batch(entries: list, token: token, etag: timing.etag) }
            catch let error as HTTPError where error.status == 401 {
                Log.warn("[batch] received 401 — rotating token and retrying once...")
                let token: String
                do { token = try await tokens.token(forceRotation: true) } catch {
                    Log.error("[batch] token rotation failed: \(error.localizedDescription)")
                    Log.error("[batch] run: tsq login to re-authenticate")
                    logged = true
                    throw error
                }
                guard expected == generation, !Task.isCancelled else { return }
                do { response = try await api.batch(entries: list, token: token, etag: timing.etag) }
                catch {
                    Log.error("[batch] heartbeat failed after token rotation: \(error.localizedDescription)")
                    if let retry = error as? HTTPError, retry.status == 401 {
                        Log.error("[batch] run: tsq login to re-authenticate")
                        track("task_poll_auth_failed", nil) // still unauthorized: the user must run tsq login
                    }
                    logged = true
                    throw error
                }
            }
            guard expected == generation, !Task.isCancelled else { return }
            if response.status == 304 {
                Log.debug("[batch] 304 — inbox unchanged, all agents idle")
                next = timing.receive(status: 304)
            } else {
                let body = try JSONDecoder().decode(JSONValue.self, from: response.data)
                let agents = body["agents"]?.array?.filter { $0.object != nil } ?? []
                next = timing.receive(status: response.status, etag: response.headers["etag"] ?? "", agents: agents)
                await receive(agents)
            }
        } catch {
            guard expected == generation, !Task.isCancelled else { return }
            if let http = error as? HTTPError {
                next = timing.receive(status: http.status)
                if http.status == 429 {
                    Log.warn("[batch] rate limited (429) — backing off \(GoTime.duration(next))")
                    track("task_poll_rate_limited", ["backoff_ms": .number(Double(next.components.seconds * 1000))])
                } else if !logged { Log.error("[batch] heartbeat failed: \(error.localizedDescription)") }
            } else if !logged, !(error is CancellationError) { Log.error("[batch] heartbeat failed: \(error.localizedDescription)") }
            await onError(error)
        }
        guard expected == generation, !Task.isCancelled, let trigger else { return }
        timer = Task {
            do { try await Task.sleep(for: next) } catch { return }
            trigger.yield()
        }
    }
}

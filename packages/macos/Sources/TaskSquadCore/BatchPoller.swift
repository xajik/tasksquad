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
    private let initialInterval: Int
    private var timing: BatchTiming
    private var loop: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var trigger: AsyncStream<Void>.Continuation?
    private var generation: UInt64 = 0

    public init(api: WorkerAPI, tokens: any TokenProvider, pollInterval: Int,
                entries: @escaping Entries, receive: @escaping Receiver,
                onError: @escaping ErrorHandler) {
        self.api = api; self.tokens = tokens; self.initialInterval = pollInterval
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

    public func forcePoll() { trigger?.yield() }

    public func stop() {
        generation &+= 1
        timer?.cancel(); timer = nil
        loop?.cancel(); loop = nil
        trigger?.finish(); trigger = nil
    }

    private func cycle(generation expected: UInt64) async {
        guard expected == generation, !Task.isCancelled else { return }
        timer?.cancel(); timer = nil
        var next = timing.interval
        do {
            let token = try await tokens.token(forceRotation: false)
            let list = await entries()
            guard expected == generation, !Task.isCancelled else { return }
            let response: HTTPResult
            do { response = try await api.batch(entries: list, token: token, etag: timing.etag) }
            catch let error as HTTPError where error.status == 401 {
                let token = try await tokens.token(forceRotation: true)
                guard expected == generation, !Task.isCancelled else { return }
                response = try await api.batch(entries: list, token: token, etag: timing.etag)
            }
            guard expected == generation, !Task.isCancelled else { return }
            if response.status == 304 {
                next = timing.receive(status: 304)
            } else {
                let body = try JSONDecoder().decode(JSONValue.self, from: response.data)
                let agents = body["agents"]?.array?.filter { $0.object != nil } ?? []
                next = timing.receive(status: response.status, etag: response.headers["etag"] ?? "", agents: agents)
                await receive(agents)
            }
        } catch {
            guard expected == generation, !Task.isCancelled else { return }
            if let http = error as? HTTPError { next = timing.receive(status: http.status) }
            await onError(error)
        }
        guard expected == generation, !Task.isCancelled, let trigger else { return }
        timer = Task {
            do { try await Task.sleep(for: next) } catch { return }
            trigger.yield()
        }
    }
}

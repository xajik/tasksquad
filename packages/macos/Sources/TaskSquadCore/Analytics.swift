import Foundation

/// Opt-in product analytics ([analytics] enabled + api_key). Port of
/// packages/daemon/analytics/amplitude.go: same events and payload — a JSON
/// array posted to Amplitude's batch endpoint every 10 seconds, at most 100
/// queued, dropped when full. Disabled clients ignore every call.
public actor Analytics {
    public static let endpoint = URL(string: "https://api.amplitude.com/batch")!
    private let enabled: Bool
    private let deviceID: String
    private let appVersion: String
    private let transport: any HTTPTransport
    private var queue: [JSONValue] = []
    private var loop: Task<Void, Never>?

    public init(enabled: Bool, apiKey: String, deviceID: String, appVersion: String,
                transport: any HTTPTransport = NativeHTTPTransport(), flushInterval: Duration = .seconds(10)) {
        self.enabled = enabled && !apiKey.isEmpty
        self.deviceID = deviceID; self.appVersion = appVersion; self.transport = transport; self.flushInterval = flushInterval
    }

    private let flushInterval: Duration

    deinit { loop?.cancel() }

    public static let disabled = Analytics(enabled: false, apiKey: "", deviceID: "", appVersion: "")

    /// Fire-and-forget from synchronous code.
    public nonisolated func track(_ event: String, _ properties: [String: JSONValue]? = nil) {
        Task { await enqueue(event, properties) }
    }

    public nonisolated func identify(_ userID: String) {
        track("$identify", ["$set": .object(["user_id": .string(userID)])])
    }

    func enqueue(_ event: String, _ properties: [String: JSONValue]?) {
        guard enabled else { return }
        guard queue.count < 100 else { Log.warn("[analytics] queue full, dropping event: \(event)"); return }
        if loop == nil {
            let interval = flushInterval
            loop = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: interval) } catch { return }
                    await self?.flush()
                }
            }
        }
        var object: [String: JSONValue] = ["event_type": .string(event), "device_id": .string(deviceID),
                                           "time": .number(Double(Int64(Date().timeIntervalSince1970 * 1000)))]
        if !appVersion.isEmpty { object["app_version"] = .string(appVersion) }
        if let properties, !properties.isEmpty { object["properties"] = .object(properties) }
        queue.append(.object(object))
    }

    /// Best effort: delivery errors are ignored, as in Go.
    public func flush() async {
        guard enabled, !queue.isEmpty, let body = try? JSONEncoder().encode(JSONValue.array(queue)) else { return }
        queue.removeAll()
        var request = URLRequest(url: Self.endpoint, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        _ = try? await transport.send(request)
    }

    public func stop() async {
        loop?.cancel(); loop = nil
        await flush()
    }
}

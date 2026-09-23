import Foundation

public struct LoginCallback: Decodable, Sendable {
    public let idToken: String
    public let refreshToken: String
    public let email: String
    enum CodingKeys: String, CodingKey { case idToken = "id_token", refreshToken = "refresh_token", email }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        idToken = try c.decodeIfPresent(String.self, forKey: .idToken) ?? ""
        refreshToken = try c.decodeIfPresent(String.self, forKey: .refreshToken) ?? ""
        email = try c.decodeIfPresent(String.self, forKey: .email) ?? ""
    }
}

public struct LoginFlow: Sendable {
    public let browserURL: URL
    private let server: LocalHTTPServer
    private let callbacks: AsyncThrowingStream<LoginCallback, Error>
    private let continuation: AsyncThrowingStream<LoginCallback, Error>.Continuation
    private let timeout: Task<Void, Never>

    public static func begin(dashboardURL: String, timeout: Duration = .seconds(300)) async throws -> Self {
        let (stream, continuation) = AsyncThrowingStream<LoginCallback, Error>.makeStream(bufferingPolicy: .bufferingOldest(1))
        let cors = ["Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type"]
        let server = try LocalHTTPServer(bodyLimit: 16 * 1024) { request in
            guard request.path == "/callback" else { return .init(status: 404) }
            if request.method == "OPTIONS" { return .init(status: 204, headers: cors) }
            guard request.method == "POST" else { return .init(status: 405, headers: cors) }
            guard let callback = try? JSONDecoder().decode(LoginCallback.self, from: request.body), !callback.idToken.isEmpty else {
                return .init(status: 400, headers: cors, body: Data("missing id_token".utf8), onSent: {
                    continuation.finish(throwing: ConfigurationError("missing id_token in callback"))
                })
            }
            var headers = cors
            headers["Content-Type"] = "text/html; charset=utf-8"
            return .init(headers: headers, body: Data("<!doctype html><title>TaskSquad</title><p>Logged in successfully. You can close this window and return to TaskSquad.</p>".utf8), onSent: {
                continuation.yield(callback)
                continuation.finish()
            })
        }
        let port = try await server.start()
        guard var url = URLComponents(string: dashboardURL + "/auth/cli"),
              ["https", "http"].contains(url.scheme), url.host != nil else {
            await server.stop()
            throw URLError(.badURL)
        }
        url.queryItems = [URLQueryItem(name: "redirect_uri", value: "http://localhost:\(port)/callback")]
        guard let browserURL = url.url else { await server.stop(); throw URLError(.badURL) }
        let deadline = Task {
            do { try await Task.sleep(for: timeout) } catch { return }
            continuation.finish(throwing: ConfigurationError("Login timed out"))
            await server.stop()
        }
        return Self(browserURL: browserURL, server: server, callbacks: stream, continuation: continuation, timeout: deadline)
    }

    public func result() async throws -> LoginCallback {
        try await withTaskCancellationHandler {
            do {
                for try await callback in callbacks {
                    await cancel()
                    return callback
                }
                throw CancellationError()
            } catch { await cancel(); throw error }
        } onCancel: { Task { await cancel() } }
    }

    public func cancel() async {
        timeout.cancel()
        continuation.finish()
        await server.stop()
    }
}

import Foundation

public struct ArtifactUploader: Sendable {
    public let api: WorkerAPI
    public let tokens: any TokenProvider
    public let agentID: String
    public init(api: WorkerAPI, tokens: any TokenProvider, agentID: String) {
        self.api = api; self.tokens = tokens; self.agentID = agentID
    }

    public func attachLog(sessionID: String, content: String) async throws {
        guard !sessionID.isEmpty, !content.isEmpty else { return }
        let key = try await upload(sessionID: sessionID, filename: "full.log", data: Data(content.utf8))
        _ = try await post("/daemon/sessions/\(sessionID)/attach", body: .object(["r2_log_key": .string(key)]))
    }

    public func attach(sessionID: String, messageID: String, filename: String, data: Data,
                       imageMIMEType: String? = nil) async throws {
        guard !sessionID.isEmpty, !data.isEmpty else { return }
        let key = try await upload(sessionID: sessionID, filename: filename, data: data)
        if !messageID.isEmpty {
            let body: JSONValue
            if let mime = imageMIMEType {
                body = .object(["image_key": .string(key), "filename": .string(filename), "mime_type": .string(mime)])
            } else { body = .object(["transcript_key": .string(key)]) }
            _ = try await post("/daemon/messages/\(messageID)/attach", body: body)
        }
    }

    private func upload(sessionID: String, filename: String, data: Data) async throws -> String {
        let response = try await post("/daemon/r2/presign", body: .object(["session_id": .string(sessionID), "filename": .string(filename)]))
        guard let rawURL = response["upload_url"]?.string, let url = URL(string: rawURL),
              ["https", "http"].contains(url.scheme), url.host != nil,
              let key = response["key"]?.string, !key.isEmpty else { throw ConfigurationError("Presign response missing URL or key") }
        let dek = response["dek"]?.string ?? ""
        let payload = try dek.isEmpty ? data : PayloadEncryption.encrypt(data, key: dek)
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "PUT"
        request.httpBody = payload
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        // The presigned URL carries upload authorization; never forward the user's bearer token.
        try await api.transport.send(request).requireSuccess()
        return key
    }

    private func post(_ path: String, body: JSONValue) async throws -> JSONValue {
        let token = try await tokens.token(forceRotation: false)
        let response = try await api.send(path: path, token: token, agentID: agentID, body: body)
        return response.data.isEmpty ? .object([:]) : try JSONDecoder().decode(JSONValue.self, from: response.data)
    }
}

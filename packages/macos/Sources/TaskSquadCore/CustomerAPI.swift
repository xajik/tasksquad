import Foundation

/// Customer endpoints deliberately omit X-TSQ-Agent: their scope comes from the
/// signed-in user and team, never from a local daemon configuration.
public struct CustomerAPI: Sendable {
    public let baseURL: URL
    private let transport: any HTTPTransport
    private let token: @Sendable (Bool) async throws -> String

    public init(baseURL: URL, transport: any HTTPTransport = NativeHTTPTransport(),
                token: @escaping @Sendable (Bool) async throws -> String) {
        self.baseURL = baseURL; self.transport = transport; self.token = token
    }

    public func url(_ path: [String], query: [String: String] = [:]) throws -> URL {
        guard ["https", "http"].contains(baseURL.scheme), baseURL.host != nil,
              baseURL.user == nil, baseURL.password == nil else { throw URLError(.badURL) }
        var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        // Percent-encode each segment independently, including slashes in IDs.
        let suffix = try path.map { segment -> String in
            guard !segment.isEmpty, segment != ".", segment != "..",
                  let encoded = segment.addingPercentEncoding(withAllowedCharacters: allowed)
            else { throw URLError(.badURL) }
            return encoded
        }.joined(separator: "/")
        parts.percentEncodedPath = parts.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/")).isEmpty
            ? "/" + suffix : parts.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/")).withLeadingSlash + "/" + suffix
        parts.queryItems = query.isEmpty ? nil : query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        parts.fragment = nil
        guard let result = parts.url else { throw URLError(.badURL) }
        return result
    }

    public func request(_ path: [String], method: String = "GET", query: [String: String] = [:],
                        body: JSONValue? = nil, files: [CustomerUpload] = []) async throws -> JSONValue {
        let data = try await data(path, method: method, query: query, body: body, files: files)
        if data.isEmpty { return .null }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    public func data(_ path: [String], method: String = "GET", query: [String: String] = [:],
                     body: JSONValue? = nil, files: [CustomerUpload] = []) async throws -> Data {
        var request = URLRequest(url: try url(path, query: query))
        request.httpMethod = method
        if !files.isEmpty {
            let boundary = "TaskSquad-" + UUID().uuidString
            request.setValue("multipart/form-data; boundary=" + boundary, forHTTPHeaderField: "Content-Type")
            request.httpBody = try Self.multipart(body: body, files: files, boundary: boundary)
        } else if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        for attempt in 0...1 {
            try Task.checkCancellation()
            request.setValue("Bearer " + (try await token(attempt == 1)), forHTTPHeaderField: "Authorization")
            let result = try await transport.send(request)
            try Task.checkCancellation()
            if result.status == 401, attempt == 0 { continue }
            guard (200..<300).contains(result.status) else {
                let value = try? JSONDecoder().decode(JSONValue.self, from: result.data)
                throw CustomerAPIError(status: result.status,
                    message: value?["error"]?.string ?? value?["message"]?.string ?? "Request failed (HTTP \(result.status)).")
            }
            return result.data
        }
        throw CustomerAPIError(status: 401, message: "Please sign in again.")
    }

    public static func multipart(body: JSONValue?, files: [CustomerUpload], boundary: String) throws -> Data {
        var result = Data()
        func append(_ text: String) { result.append(Data(text.utf8)) }
        for (key, value) in (body?.object ?? [:]).sorted(by: { $0.key < $1.key }) {
            guard !key.contains(where: { "\r\n\"".contains($0) }) else { throw URLError(.badURL) }
            if value == .null { continue }
            let text = try value.string ?? String(decoding: JSONEncoder().encode(value), as: UTF8.self)
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(text)\r\n")
        }
        for file in files {
            let safeName = file.name.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
            guard !file.mimeType.contains(where: { "\r\n".contains($0) }) else { throw URLError(.badURL) }
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"images\"; filename=\"\(safeName)\"\r\nContent-Type: \(file.mimeType)\r\n\r\n")
            result.append(file.data); append("\r\n")
        }
        append("--\(boundary)--\r\n")
        return result
    }
}

public struct CustomerAPIError: LocalizedError, Sendable {
    public let status: Int
    public let message: String
    public var errorDescription: String? { message }
}

public struct CustomerUpload: Identifiable, Sendable {
    public let id = UUID()
    public let name: String
    public let mimeType: String
    public let data: Data
    public init(name: String, mimeType: String, data: Data) { self.name = name; self.mimeType = mimeType; self.data = data }
}

/// The API adds optional fields regularly. Keep them intact while exposing the
/// common presentation fields, rather than losing them during a partial decode.
public struct CustomerRecord: Identifiable, Equatable, Sendable {
    public let value: JSONValue
    public init(_ value: JSONValue) { self.value = value }
    public var id: String { text("id", fallback: text("planner_id", fallback: text("phase_id"))) }
    public func text(_ key: String, fallback: String = "") -> String { value[key]?.string ?? fallback }
    public func number(_ key: String) -> Double { value[key]?.number ?? 0 }
    public func flag(_ key: String) -> Bool {
        if case .bool(let value) = value[key] { return value }
        return number(key) != 0
    }
    public func records(_ key: String) -> [CustomerRecord] { (value[key]?.array ?? []).map(CustomerRecord.init) }
    public func strings(_ key: String) -> [String] { (value[key]?.array ?? []).compactMap(\.string) }
    public var title: String { ["subject", "title", "name", "email", "period_key"].compactMap { value[$0]?.string }.first ?? id }
    public var status: String { text("status") }
    public var date: Date { Date(timeIntervalSince1970: number("created_at") / 1000) }
}

private extension String { var withLeadingSlash: String { "/" + self } }

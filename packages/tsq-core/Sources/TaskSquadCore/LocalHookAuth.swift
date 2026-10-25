import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// Shared with Go's hookauth: a private per-port capability, never a cloud credential.
public enum LocalHookAuth {
    public static func file(port: Int, paths: TaskSquadPaths = .init()) -> URL {
        paths.root.appendingPathComponent("hooks-\(port).token")
    }

    public static func read(port: Int, paths: TaskSquadPaths = .init()) throws -> String {
        let fd = open(file(port: port, paths: paths).path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o077 == 0 else {
            throw ConfigurationError("Hook capability must be a private regular file")
        }
        let data = try handle.readToEnd() ?? Data()
        guard data.count == 64, data.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw ConfigurationError("Invalid hook capability")
        }
        return String(decoding: data, as: UTF8.self)
    }

    static func loadOrCreate(port: Int, paths: TaskSquadPaths) throws -> String {
        do { return try read(port: port, paths: paths) }
        catch let error as POSIXError where error.code == .ENOENT { }
        try paths.createRoot()
        let token = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        let fd = open(file(port: port, paths: paths).path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0o600)
        guard fd >= 0 else {
            if errno == EEXIST { return try read(port: port, paths: paths) }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        try handle.write(contentsOf: Data(token.utf8))
        return token
    }

    static func rejection(_ request: LocalHTTPRequest, token: String) -> Int? {
        guard request.headers["origin"] == nil, request.headers["sec-fetch-site"] == nil,
              let host = request.headers["host"], let url = URLComponents(string: "http://" + host),
              url.user == nil, url.password == nil, url.path.isEmpty, url.query == nil, url.fragment == nil,
              ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host?.lowercased() ?? "") else { return 403 }
        guard request.method == "POST" else { return 405 }
        let authorization = request.headers["authorization"] ?? ""
        var supplied = authorization.hasPrefix("Bearer ") ? String(authorization.dropFirst(7)) : ""
        if supplied.isEmpty, ["/hooks/stop", "/hooks/event"].contains(request.path) {
            supplied = request.components?.queryItems?.first(where: { $0.name == "hook_token" })?.value ?? ""
        }
        let expected = Array(token.utf8), actual = Array(supplied.utf8)
        guard !expected.isEmpty, expected.count == actual.count else { return 401 }
        var difference: UInt8 = 0
        for index in expected.indices { difference |= expected[index] ^ actual[index] }
        return difference == 0 ? nil : 401
    }
}

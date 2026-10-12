import Foundation

public struct ProcessSpecification: Sendable {
    public var executable: String
    public var arguments: [String]
    public var directory: String?
    public var environment: [String: String]
    public var input: Data?
    public init(executable: String, arguments: [String] = [], directory: String? = nil,
                environment: [String: String] = ProcessInfo.processInfo.environment, input: Data? = nil) {
        self.executable = executable; self.arguments = arguments; self.directory = directory
        self.environment = environment; self.input = input
    }
}

public enum ProcessChannel: Sendable { case stdout, stderr }
public struct ProcessExit: Sendable, Equatable {
    public let code: Int32
    public let signal: Int32?
    public init(code: Int32, signal: Int32?) { self.code = code; self.signal = signal }
}

public enum ExecutableLocator {
    public static func find(_ name: String, environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        let candidates = name.contains("/") ? [name] : (environment["PATH"] ?? "").components(separatedBy: ":").map {
            ($0.isEmpty ? "." : $0) + "/" + name
        }
        return candidates.first {
            var info = stat()
            return stat($0, &info) == 0 && info.st_mode & S_IFMT != S_IFDIR && access($0, X_OK) == 0
        }
    }
}

/// Native process launch with byte-preserving argv/env and no shell interpolation.
/// Spawning is OS-specific (see `PlatformServices.runProcess`); reads await their
/// consumer, so a slow consumer backpressures the child.
public enum NativeProcess {
    public static func run(_ specification: ProcessSpecification,
                           output: @escaping @Sendable (ProcessChannel, Data) async throws -> Void = { _, _ in },
                           started: @Sendable (pid_t) async -> Void = { _ in }) async throws -> ProcessExit {
        try await Platform.current.runProcess(specification, output: output, started: started)
    }
}

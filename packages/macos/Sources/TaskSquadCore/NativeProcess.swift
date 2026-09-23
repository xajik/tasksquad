import Foundation
import Darwin

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

/// Native process launch with byte-preserving argv/env (Foundation Process may
/// normalize Unicode through filesystem representations). No shell interpolation.
/// Reads await their consumer, so a slow consumer backpressures the child instead
/// of dropping bytes or growing an unbounded in-memory output queue.
public enum NativeProcess {
    public static func run(_ specification: ProcessSpecification,
                           output: @escaping @Sendable (ProcessChannel, Data) async throws -> Void = { _, _ in }) async throws -> ProcessExit {
        try Task.checkCancellation()
        let child = try ChildProcess(specification)
        return try await withTaskCancellationHandler {
            // Always create the wait task, even if cancellation raced with spawn,
            // so the child is reaped after the cancellation handler terminates it.
            return try await withThrowingTaskGroup(of: ProcessExit?.self) { group in
                for (channel, descriptor) in [(ProcessChannel.stdout, child.stdout), (.stderr, child.stderr)] {
                    group.addTask {
                        defer { child.outputFinished() }
                        // One detached task drains the whole channel instead of spinning
                        // a fresh Task per chunk, which added a thread-pool hop per 64KB read.
                        try await Task.detached {
                            while true {
                                // Cancellation terminates the process group; continue to
                                // drain already-written output before reporting its exit.
                                let data = try readChunk(descriptor)
                                if data.isEmpty { return }
                                try await output(channel, data)
                            }
                        }.value
                        return nil
                    }
                }
                group.addTask {
                    try await Task.detached {
                        defer { child.closeInput() }
                        if let input = specification.input { try writeAll(input, descriptor: child.stdin) }
                    }.value
                    return nil
                }
                group.addTask {
                    let exit = try await Task.detached { try child.wait() }.value
                    // The direct child exited, but a descendant it spawned can still
                    // hold the output pipes open (dup'd fds aren't CLOEXEC across
                    // posix_spawn), which would otherwise block the drain loops in
                    // an EOF-less read forever. terminate() already accounts for
                    // this (see its "launcher can exit..." comment) and is a no-op
                    // once both output channels have actually finished.
                    child.terminate()
                    return exit
                }
                var result: ProcessExit?
                do {
                    for try await value in group { if let value { result = value } }
                } catch {
                    child.terminate()
                    group.cancelAll()
                    throw error
                }
                try Task.checkCancellation()
                guard let result else { throw ConfigurationError("Child exited without a wait status") }
                return result
            }
        } onCancel: { child.terminate() }
    }

    private static func readChunk(_ descriptor: Int32) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(descriptor, &bytes, bytes.count)
            if count >= 0 { return Data(bytes.prefix(count)) }
            if errno != EINTR { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        }
    }

    private static func writeAll(_ data: Data, descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count }
                else if count < 0 && errno == EINTR { continue }
                // A provider may close stdin after reading just the prompt it needs.
                else if count < 0 && errno == EPIPE { return }
                else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            }
        }
    }
}

private final class ChildProcess: @unchecked Sendable {
    let pid: pid_t
    let stdout: Int32
    let stderr: Int32
    let stdin: Int32
    private let lock = NSLock()
    private var exited = false
    private var inputClosed = false
    private var terminating = false
    private var finishedOutputs = 0

    init(_ spec: ProcessSpecification) throws {
        guard let executable = ExecutableLocator.find(spec.executable, environment: spec.environment) else {
            throw ConfigurationError("Executable not found: \(spec.executable)")
        }
        let arguments = [spec.executable] + spec.arguments
        let environment = spec.environment.sorted(by: { $0.key < $1.key }).map { $0.key + "=" + $0.value }
        guard (arguments + environment + [spec.directory ?? ""]).allSatisfy({ !$0.utf8.contains(0) }) else {
            throw ConfigurationError("Process arguments, environment, and directory must not contain NUL")
        }
        var descriptors: [Int32] = []
        var spawned = false
        defer { if !spawned { descriptors.forEach { close($0) } } }
        func pipePair() throws -> [Int32] {
            var pair = [Int32](repeating: 0, count: 2)
            guard pipe(&pair) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            descriptors += pair
            for fd in pair { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
            return pair
        }
        let input = try pipePair(), out = try pipePair(), err = try pipePair()
        _ = fcntl(input[1], F_SETNOSIGPIPE, 1)
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        try Self.check(posix_spawn_file_actions_init(&actions))
        defer { posix_spawn_file_actions_destroy(&actions) }
        try Self.check(posix_spawnattr_init(&attributes))
        defer { posix_spawnattr_destroy(&attributes) }
        try Self.check(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)))
        try Self.check(posix_spawnattr_setpgroup(&attributes, 0))
        var mask = sigset_t(), defaults = sigset_t()
        sigemptyset(&mask); sigemptyset(&defaults)
        for signal in [SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGPIPE] { sigaddset(&defaults, signal) }
        try Self.check(posix_spawnattr_setsigmask(&attributes, &mask))
        try Self.check(posix_spawnattr_setsigdefault(&attributes, &defaults))
        for (source, target) in [(input[0], STDIN_FILENO), (out[1], STDOUT_FILENO), (err[1], STDERR_FILENO)] {
            try Self.check(posix_spawn_file_actions_adddup2(&actions, source, target))
        }
        if let directory = spec.directory, !directory.isEmpty {
            try Self.check(posix_spawn_file_actions_addchdir_np(&actions, directory))
        }
        let argv = arguments.map { strdup($0) } + [nil]
        let envp = environment.map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) }; envp.forEach { free($0) } }
        var childPID: pid_t = 0
        let status = argv.withUnsafeBufferPointer { argv in
            envp.withUnsafeBufferPointer { envp in
                posix_spawn(&childPID, executable, &actions, &attributes, argv.baseAddress!, envp.baseAddress!)
            }
        }
        try Self.check(status)
        pid = childPID; stdin = input[1]; stdout = out[0]; stderr = err[0]
        close(input[0]); close(out[1]); close(err[1])
        spawned = true
    }

    deinit {
        close(stdout); close(stderr)
        if !inputClosed { close(stdin) }
    }

    func closeInput() {
        lock.withLock {
            if !inputClosed { close(stdin); inputClosed = true }
        }
    }

    func outputFinished() { lock.withLock { finishedOutputs += 1 } }

    func wait() throws -> ProcessExit {
        var status: Int32 = 0
        while waitpid(pid, &status, 0) < 0 {
            if errno != EINTR { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        }
        lock.withLock { exited = true }
        let signal = status & 0x7f
        return signal == 0 ? ProcessExit(code: (status >> 8) & 0xff, signal: nil) : ProcessExit(code: 128 + signal, signal: signal)
    }

    func terminate() {
        let shouldEscalate = lock.withLock {
            // A launcher can exit while descendants still hold its output pipes.
            guard (!exited || finishedOutputs < 2), !terminating else { return false }
            terminating = true
            _ = kill(-pid, SIGTERM)
            return true
        }
        guard shouldEscalate else { return }
        // Do not wait on the UI/main actor, and check liveness before escalating.
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [self] in
            lock.withLock { if !exited || finishedOutputs < 2 { _ = kill(-pid, SIGKILL) } }
        }
    }

    private static func check(_ status: Int32) throws {
        if status != 0 { throw POSIXError(POSIXErrorCode(rawValue: status) ?? .EIO) }
    }
}

import Foundation
import Darwin

/// Timing for interactive (tmux) providers; ports packages/daemon/tmux. Tests
/// shorten these; production values match Go.
public struct InteractiveTiming: Sendable {
    /// Time for a CLI's TUI to initialise before the first prompt is typed.
    public var readyWait: Duration = .seconds(15)
    /// Prompt text and Enter are separate send-keys calls; merged, Claude's TUI misses Enter.
    public var submitWait: Duration = .seconds(2)
    /// Delay before typing an inbox reply into a paused session.
    public var replyDelay: Duration = .seconds(1)
    /// Hook-driven completion of a pipe provider waits this long for its process to exit.
    public var pipeExitGrace: Duration = .seconds(15)
    public var fifoOpenTimeout: Duration = .seconds(5)
    public init() { }
}

/// tmux operations for one managed task session. The session is `tsq-<sessionID>`
/// and its pane output reaches the engine through `pipe-pane` into a FIFO.
struct TmuxTaskSession: Sendable {
    let tmux: TmuxConnection
    let name: String
    let fifoPath: String

    init(tmux: TmuxConnection, sessionID: String) throws {
        // Session IDs are server-issued ULIDs; anything else would reach tmux target
        // syntax and the pipe-pane shell command, so reject it outright.
        guard !sessionID.isEmpty, sessionID.unicodeScalars.allSatisfy({
            CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_"
        }) else { throw ConfigurationError("Invalid session ID for tmux: \(sessionID)") }
        self.tmux = tmux
        name = "tsq-\(sessionID)"
        fifoPath = "/tmp/tsq-\(sessionID).fifo"
    }

    /// A Portal's bare interactive session, `tsq-portal-<first8CharsOfID>`, the
    /// same name the Go daemon uses (its orphan sweep excludes this prefix).
    init(tmux: TmuxConnection, portalID: String) throws {
        _ = try TmuxTaskSession(tmux: tmux, sessionID: portalID)
        let suffix = String(portalID.prefix(8))
        self.tmux = tmux
        name = "tsq-portal-\(suffix)"
        fifoPath = "/tmp/tsq-portal-\(suffix).fifo"
    }

    func start(command: [String], directory: String, environment: [String: String]) async throws {
        let variables = environment.sorted { $0.key < $1.key }.flatMap { ["-e", "\($0.key)=\($0.value)"] }
        _ = try await tmux.run(["new-session", "-d", "-s", name, "-c", directory] + variables + ["--"] + command)
    }

    /// Creates the FIFO, attaches pipe-pane, and returns a stream of pane output
    /// that finishes when the session ends (pipe-pane's writer closes).
    func pipeOutput(timeout: Duration) async throws -> AsyncStream<Data> {
        unlink(fifoPath)
        guard mkfifo(fifoPath, 0o600) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let opener = FIFOOpener(path: fifoPath)
        // The reader must be waiting before pipe-pane's `cat` opens the write end.
        async let descriptor = opener.open(timeout: timeout)
        let quoted = "'" + fifoPath.replacingOccurrences(of: "'", with: "'\\''") + "'"
        do { _ = try await tmux.run(["pipe-pane", "-t", name, "cat > " + quoted]) }
        catch { opener.abandon(); _ = try? await descriptor; throw error }
        let fd = try await descriptor
        return AsyncStream { continuation in
            let thread = Thread {
                var buffer = [UInt8](repeating: 0, count: 64 * 1024)
                while true {
                    let count = read(fd, &buffer, buffer.count)
                    if count > 0 { continuation.yield(Data(buffer.prefix(count))) }
                    else if count < 0 && errno == EINTR { continue }
                    else { break }
                }
                close(fd)
                continuation.finish()
            }
            thread.name = "tsq-fifo-\(name)"
            thread.start()
        }
    }

    func sendText(_ text: String, timing: InteractiveTiming) async throws {
        _ = try await tmux.run(["send-keys", "-t", name, "-l", text])
        try await Task.sleep(for: timing.submitWait)
        _ = try await tmux.run(["send-keys", "-t", name, "C-m"])
    }

    /// Codex loses spaces/newlines from send-keys while switching views; paste instead.
    func pasteText(_ text: String, timing: InteractiveTiming) async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("tsq-codex-reply-\(UUID().uuidString).txt")
        try Data(text.utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        _ = try await tmux.run(["load-buffer", "-b", "tsq-codex-reply", file.path])
        _ = try await tmux.run(["paste-buffer", "-b", "tsq-codex-reply", "-t", name])
        try await Task.sleep(for: timing.submitWait)
        _ = try await tmux.run(["send-keys", "-t", name, "C-m"])
    }

    func capture() async -> String {
        guard let output = try? await tmux.run(["capture-pane", "-t", name, "-p", "-S", "-"]) else { return "" }
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func kill() async { _ = try? await tmux.run(["kill-session", "-t", name]) }

    func removeFIFO() { unlink(fifoPath) }

    /// Returns the session owning `pane` (a `%<n>` pane ID), or nil.
    func owns(pane: String) async -> Bool {
        guard pane.first == "%", pane.dropFirst().allSatisfy(\.isASCII), pane.dropFirst().allSatisfy(\.isNumber), pane.count > 1,
              let owner = try? await tmux.run(["display-message", "-p", "-t", pane, "#{session_name}"]) else { return false }
        return owner.trimmingCharacters(in: .whitespacesAndNewlines) == name
    }

    func sendBytes(_ data: Data, pane: String) async throws {
        _ = try await tmux.run(["send-keys", "-H", "-t", pane] + data.map { String(format: "%02x", $0) })
    }
}

/// Blocking FIFO open on a dedicated thread, bounded by a timeout. On timeout or
/// abandonment the waiting open is released by briefly opening the write end.
private final class FIFOOpener: @unchecked Sendable {
    private let path: String
    private let lock = NSLock()
    private var abandoned = false
    init(path: String) { self.path = path }

    func abandon() {
        lock.withLock { abandoned = true }
        let writer = Darwin.open(path, O_WRONLY | O_NONBLOCK | O_CLOEXEC)
        if writer >= 0 { close(writer) }
    }

    func open(timeout: Duration) async throws -> Int32 {
        let timer = Task { [self] in
            try await Task.sleep(for: timeout)
            abandon()
        }
        defer { timer.cancel() }
        let fd: Int32 = await withCheckedContinuation { continuation in
            Thread.detachNewThread { [path] in
                var fd: Int32
                repeat { fd = Darwin.open(path, O_RDONLY | O_CLOEXEC) } while fd < 0 && errno == EINTR
                continuation.resume(returning: fd)
            }
        }
        let wasAbandoned = lock.withLock { abandoned }
        if wasAbandoned || fd < 0 {
            if fd >= 0 { close(fd) }
            throw ConfigurationError(fd < 0 ? "FIFO open failed" : "FIFO open timed out")
        }
        return fd
    }
}

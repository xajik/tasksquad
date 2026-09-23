import Foundation
import Darwin

public struct TmuxPane: Identifiable, Sendable, Hashable {
    public var id: String { sessionID + ":" + paneID }
    public let sessionID: String
    public let sessionName: String
    public let windowID: String
    public let paneID: String
    public let command: String
    public let directory: String
    public let title: String
    public let dead: Bool
    public var isAgent: Bool { sessionName.hasPrefix("tsq-") }

    public static let format = "#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}\t#{pane_dead}"
    public static func parse(_ output: String) -> [Self] {
        output.split(separator: "\n").compactMap { line in
            let fields = line.components(separatedBy: "\t")
            guard fields.count == 8, validID(fields[0], prefix: "$"), validID(fields[2], prefix: "@"), validID(fields[3], prefix: "%") else { return nil }
            return Self(sessionID: fields[0], sessionName: fields[1], windowID: fields[2], paneID: fields[3],
                        command: fields[4], directory: fields[5], title: fields[6], dead: fields[7] == "1")
        }
    }
    public static func validID(_ value: String, prefix: Character) -> Bool {
        value.first == prefix && value.count > 1 && value.dropFirst().utf8.allSatisfy { (48...57).contains($0) }
    }
}

private actor TmuxOutput {
    var data = Data()
    func append(_ chunk: Data) throws {
        guard data.count + chunk.count <= 4 * 1024 * 1024 else { throw ConfigurationError("tmux response exceeds 4 MiB") }
        data.append(chunk)
    }
}

public struct TmuxConnection: Sendable {
    public let executable: String
    public let socketPath: String?
    public init(executable: String = "tmux", socketPath: String? = nil) { self.executable = executable; self.socketPath = socketPath }
    var prefix: [String] { socketPath.map { ["-S", $0] } ?? [] }
    public func run(_ arguments: [String]) async throws -> String {
        let out = TmuxOutput(), err = TmuxOutput()
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "TMUX")
        let status = try await NativeProcess.run(.init(executable: executable, arguments: prefix + arguments, environment: environment)) { channel, data in
            switch channel { case .stdout: try await out.append(data); case .stderr: try await err.append(data) }
        }
        let output = String(decoding: await out.data, as: UTF8.self)
        if status.code != 0 { throw ConfigurationError(String(decoding: await err.data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)) }
        return output
    }
    public func panes() async throws -> [TmuxPane] {
        do { return TmuxPane.parse(try await run(["list-panes", "-a", "-F", TmuxPane.format])) }
        catch {
            let message = error.localizedDescription
            if message.contains("no server running") || message.contains("No such file or directory") { return [] }
            throw error
        }
    }
    public func closeSession(_ sessionID: String) async throws {
        guard TmuxPane.validID(sessionID, prefix: "$") else { throw ConfigurationError("Invalid tmux session ID") }
        _ = try await run(["kill-session", "-t", sessionID])
    }
}

/// A separate control client, never pipe-pane: the daemon retains its output pipe.
/// All mutable protocol state lives on queue. Reads/writes are bounded and asynchronous.
public final class TmuxControlClient: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ai.tasksquad.tmux.control")
    private let process = Process()
    private let input = Pipe(), output = Pipe()
    private var source: DispatchSourceRead?
    private var buffer = Data()
    // Continuation is nil once a per-command timeout has already resumed the
    // caller; the slot stays (rather than being removed) so FIFO order against
    // tmux's own %begin/%end framing is preserved — its eventual real response
    // is then just discarded instead of double-resuming.
    private var pending: [(UUID, CheckedContinuation<String, any Error>?)] = []
    private var guardFields: String?
    private var commandOutput: [String] = []
    private var commandSize = 0
    private var requested = false
    private var stopped = false
    private var writeBuffer = Data()
    private var writer: DispatchSourceWrite?
    private let queueKey = DispatchSpecificKey<Bool>()

    public init(connection: TmuxConnection = .init(), sessionID: String) throws {
        queue.setSpecific(key: queueKey, value: true)
        guard TmuxPane.validID(sessionID, prefix: "$") else { throw ConfigurationError("Invalid tmux session ID") }
        guard let executable = ExecutableLocator.find(connection.executable) else { throw ConfigurationError("Install tmux to open agent terminals.") }
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = connection.prefix + ["-C", "attach-session", "-f", "no-output,ignore-size", "-t", sessionID]
        var environment = ProcessInfo.processInfo.environment; environment.removeValue(forKey: "TMUX")
        process.environment = environment
        process.standardInput = input; process.standardOutput = output
        // Control commands report errors through %error blocks. Startup stderr is
        // intentionally not mixed into the framed protocol.
        process.standardError = FileHandle.nullDevice
        try process.run()
        try? input.fileHandleForReading.close(); try? output.fileHandleForWriting.close()
        let fd = output.fileHandleForReading.fileDescriptor, inFD = input.fileHandleForWriting.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        _ = fcntl(inFD, F_SETFL, fcntl(inFD, F_GETFL) | O_NONBLOCK)
        _ = fcntl(inFD, F_SETNOSIGPIPE, 1)
        let reader = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        reader.setEventHandler { [weak self] in self?.readAvailable() }
        reader.setCancelHandler { [output] in try? output.fileHandleForReading.close() }
        source = reader; reader.resume()
    }

    deinit {
        // Close/terminate through `queue` so this can't race flushWrite()'s write
        // on the same fd from a deallocation that lands on some other thread, and
        // grab any still-waiting callers so we can resume them below instead of
        // leaving their Task suspended forever.
        var leftover: [(UUID, CheckedContinuation<String, any Error>?)] = []
        let cleanup = {
            leftover = self.pending; self.pending = []
            self.source?.cancel(); self.writer?.cancel()
            try? self.input.fileHandleForWriting.close()
            if self.process.isRunning { self.process.terminate() }
        }
        // disconnect() can release the last reference from this very queue.
        // Synchronizing to it again traps in libdispatch.
        if DispatchQueue.getSpecific(key: queueKey) == true { cleanup() }
        else { queue.sync(execute: cleanup) }
        for (_, continuation) in leftover { continuation?.resume(throwing: ConfigurationError("Terminal detached")) }
    }

    public func command(_ text: String) async throws -> String {
        guard !text.contains("\n"), !text.contains("\r"), !text.utf8.contains(0) else { throw ConfigurationError("Invalid tmux command framing") }
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                guard !stopped else { continuation.resume(throwing: ConfigurationError("Terminal detached")); return }
                guard pending.count < 128, writeBuffer.count + text.utf8.count < 1024 * 1024 else {
                    continuation.resume(throwing: ConfigurationError("Terminal input queue is full")); return
                }
                let id = UUID()
                pending.append((id, continuation))
                writeBuffer.append(Data((text + "\n").utf8)); flushWrite()
                queue.asyncAfter(deadline: .now() + 10) { [weak self] in
                    guard let self else { return }
                    // Fail only this command, not the whole connection: leave its
                    // slot in place (nil continuation) so FIFO framing against
                    // tmux's %begin/%end blocks still lines up for the rest.
                    guard let index = self.pending.firstIndex(where: { $0.0 == id }), let continuation = self.pending[index].1 else { return }
                    self.pending[index].1 = nil
                    continuation.resume(throwing: ConfigurationError("tmux did not respond within 10 seconds"))
                }
            }
        }
    }

    public func disconnect() { queue.async { [self] in finish(ConfigurationError("Terminal detached")) } }

    private func flushWrite() {
        guard !stopped else { return }
        while !writeBuffer.isEmpty {
            let count = writeBuffer.withUnsafeBytes { Darwin.write(input.fileHandleForWriting.fileDescriptor, $0.baseAddress, $0.count) }
            if count > 0 { writeBuffer.removeFirst(count) }
            else if errno == EINTR { continue }
            else if errno == EAGAIN {
                if writer == nil {
                    let source = DispatchSource.makeWriteSource(fileDescriptor: input.fileHandleForWriting.fileDescriptor, queue: queue)
                    source.setEventHandler { [weak self] in self?.flushWrite() }; writer = source; source.resume()
                }
                return
            } else { finish(ConfigurationError("Unable to send terminal input")); return }
        }
        writer?.cancel(); writer = nil
    }

    private func readAvailable() {
        var bytes = [UInt8](repeating: 0, count: 64 * 1024)
        while !stopped {
            let count = Darwin.read(output.fileHandleForReading.fileDescriptor, &bytes, bytes.count)
            if count > 0 {
                buffer.append(contentsOf: bytes.prefix(count))
                while let newline = buffer.firstIndex(of: 10) {
                    let line = String(decoding: buffer[..<newline], as: UTF8.self)
                    buffer.removeSubrange(...newline); receive(line)
                    if stopped { return }
                }
                if buffer.count > 4 * 1024 * 1024 { finish(ConfigurationError("tmux response exceeds limit")) }
            } else if count == 0 { finish(ConfigurationError("Session ended or terminal detached")); return }
            else if errno == EINTR { continue }
            else if errno == EAGAIN { return }
            else { finish(ConfigurationError("Unable to read terminal output")); return }
        }
    }

    private func receive(_ line: String) {
        if let fields = guardFields {
            if line == "%end " + fields || line == "%error " + fields {
                let failed = line.hasPrefix("%error")
                let output = commandOutput.joined(separator: "\n")
                guardFields = nil; commandOutput = []; commandSize = 0
                if requested, !pending.isEmpty {
                    let (_, continuation) = pending.removeFirst()
                    // nil means a per-command timeout already resumed the caller;
                    // this late response is just discarded.
                    if let continuation {
                        if failed { continuation.resume(throwing: ConfigurationError(output)) }
                        else { continuation.resume(returning: output) }
                    }
                }
                requested = false
            } else {
                commandSize += line.utf8.count
                if commandSize > 4 * 1024 * 1024 { finish(ConfigurationError("tmux screen exceeds limit")); return }
                commandOutput.append(line)
            }
        } else if line.hasPrefix("%begin ") {
            guardFields = String(line.dropFirst(7))
            requested = line.split(separator: " ").last == "1"
        } else if line.hasPrefix("%exit") { finish(ConfigurationError("Session ended or terminal detached")) }
    }

    private func finish(_ error: any Error) {
        guard !stopped else { return }
        stopped = true; source?.cancel(); source = nil; writer?.cancel(); writer = nil
        try? input.fileHandleForWriting.close()
        // EOF detaches this client. Never kill the underlying tmux session here.
        let child = process
        queue.asyncAfter(deadline: .now() + 1) { if child.isRunning { child.terminate() } }
        let callbacks = pending; pending = []; buffer.removeAll(); writeBuffer.removeAll()
        callbacks.forEach { $0.1?.resume(throwing: error) }
    }
}

public struct TerminalScreen: Sendable, Equatable {
    public let text: String
    public let columns: Int
    public let rows: Int
    public let cursorX: Int
    public let cursorY: Int
    public let cursorVisible: Bool
    public let bracketedPaste: Bool
    public let applicationCursor: Bool
    public let mouse: Bool
    public let mouseSGR: Bool
    public init(text: String, metadata: String) {
        let values = metadata.split(separator: ",", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
        func v(_ i: Int) -> Int { values.indices.contains(i) ? values[i] : 0 }
        self.text = text; columns = max(1, v(0)); rows = max(1, v(1)); cursorX = v(2); cursorY = v(3)
        cursorVisible = v(4) == 1; bracketedPaste = v(5) == 1; applicationCursor = v(6) == 1
        mouse = v(7) == 1 || v(8) == 1 || v(9) == 1; mouseSGR = v(10) == 1
    }
    public static let metadataFormat = "#{pane_width},#{pane_height},#{cursor_x},#{cursor_y},#{cursor_flag},#{bracketed_paste_flag},#{keypad_cursor_flag},#{mouse_standard_flag},#{mouse_button_flag},#{mouse_any_flag},#{mouse_sgr_flag}"
}

public enum TmuxTerminal {
    public static func screen(client: TmuxControlClient, paneID: String, history: Int = 0) async throws -> TerminalScreen {
        guard TmuxPane.validID(paneID, prefix: "%") else { throw ConfigurationError("Invalid pane ID") }
        let metadata = try await client.command("display-message -p -t \(paneID) '\(TerminalScreen.metadataFormat)'")
        let screen = try await client.command("capture-pane -p -e -N -t \(paneID) -S \(-max(0, min(history, 5000)))")
        return TerminalScreen(text: screen, metadata: metadata)
    }
    public static func send(_ bytes: Data, client: TmuxControlClient, paneID: String) async throws {
        guard TmuxPane.validID(paneID, prefix: "%") else { throw ConfigurationError("Invalid pane ID") }
        for offset in stride(from: 0, to: bytes.count, by: 512) {
            let chunk = bytes.dropFirst(offset).prefix(512).map { String(format: "%02x", $0) }.joined(separator: " ")
            _ = try await client.command("send-keys -H -t \(paneID) \(chunk)")
        }
    }
}

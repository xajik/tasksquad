import Foundation
import Darwin
import TaskSquadCore

/// Observe the directory, not the inode: editors often replace config.toml atomically.
public final class ConfigurationWatcher: @unchecked Sendable {
    private let source: DispatchSourceFileSystemObject
    public init(url: URL, paths: TaskSquadPaths = .init(),
                onChange: @escaping @Sendable (Result<DaemonConfiguration, Error>) -> Void) throws {
        let fd = open(url.deletingLastPathComponent().path, O_EVTONLY | O_CLOEXEC)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let queue = DispatchQueue(label: "ai.tasksquad.configuration")
        source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd,
            eventMask: [.write, .rename, .delete], queue: queue)
        // Access is confined to the serial queue.
        var previous = try? Data(contentsOf: url)
        source.setEventHandler {
            guard let data = try? Data(contentsOf: url), data != previous else { return }
            previous = data
            onChange(Result { try DaemonConfiguration.load(from: url, paths: paths) })
        }
        source.setCancelHandler { close(fd) }
        source.resume()
    }
    deinit { source.cancel() }
}

import Foundation

/// The daemon attachment route decrypts image bytes. Providers receive local
/// paths, never credentials or remote attachment URLs.
struct InboundAttachments: Sendable {
    let api: WorkerAPI
    let tokens: any TokenProvider
    let report: @Sendable (String) -> Void

    func materialize(_ messages: [JSONValue], agentID: String, workDir: String) async -> [JSONValue] {
        var result: [JSONValue] = []
        for message in messages {
            guard var value = message.object, let id = message["id"]?.string,
                  HarnessLayout.isSafe(id), let attachments = message["attachments"]?.array, !attachments.isEmpty else {
                result.append(message); continue
            }
            var body = message["body"]?.string ?? ""
            for attachment in attachments {
                guard let attachmentID = attachment["id"]?.string, HarnessLayout.isSafe(attachmentID) else { continue }
                do {
                    try Task.checkCancellation()
                    let token = try await tokens.token(forceRotation: false)
                    let response = try await api.send(method: "GET", path: "/daemon/messages/\(id)/attachments/\(attachmentID)",
                                                      token: token, agentID: agentID)
                    guard response.data.count <= 20 * 1024 * 1024 else { throw ConfigurationError("Attachment exceeds 20 MiB") }
                    let root = URL(fileURLWithPath: workDir, isDirectory: true)
                    let directory = root.appendingPathComponent(".tasksquad/inbox", isDirectory: true)
                    // Never follow a workspace symlink outside the attachment directory.
                    for component in [root.appendingPathComponent(".tasksquad"), directory] {
                        if (try? component.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
                            throw ConfigurationError("Attachment directory is a symbolic link")
                        }
                    }
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                            attributes: [.posixPermissions: 0o700])
                    let filename = (attachment["filename"]?.string ?? attachmentID).split(separator: "/").last.map(String.init) ?? attachmentID
                    let destination = directory.appendingPathComponent(attachmentID + "-" + filename)
                    try response.data.write(to: destination, options: .atomic)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
                    body += "\n\n[Attached image: \(destination.path)]"
                } catch {
                    report("Could not materialize attachment \(attachmentID): \(error.localizedDescription)")
                }
            }
            value["body"] = .string(body)
            result.append(.object(value))
        }
        return result
    }
}

import XCTest
@testable import TaskSquadCore

private struct AttachmentTokens: TokenProvider {
    func token(forceRotation: Bool) async throws -> String { "fixture-token" }
}

final class InboundAttachmentsTests: PlatformTestCase {
    func testMaterializesBytesWithAgentAuthAndPreservesUnicodeAndSafePaths() async throws {
        let bytes = Data([137, 80, 78, 71, 0, 255])
        let server = try LocalHTTPServer { request in
            XCTAssertEqual(request.path, "/daemon/messages/message-1/attachments/image-1")
            XCTAssertEqual(request.headers["authorization"], "Bearer fixture-token")
            XCTAssertEqual(request.headers["x-tsq-agent"], "agent-1")
            return .init(status: 200, body: bytes)
        }
        let port = try await server.start()
        let work = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: work) }
        let input = JSONValue.object(["id": .string("message-1"), "body": .string("café 猫"), "attachments": .array([
            .object(["id": .string("image-1"), "filename": .string("../../猫.png")])
        ])])
        let loader = InboundAttachments(api: WorkerAPI(baseURL: "http://127.0.0.1:\(port)"), tokens: AttachmentTokens(), report: { XCTFail($0) })
        let messages = await loader.materialize([input], agentID: "agent-1", workDir: work.path)
        let destination = work.appendingPathComponent(".tasksquad/inbox/image-1-猫.png")
        XCTAssertEqual(try Data(contentsOf: destination), bytes)
        XCTAssertEqual(messages.first?["body"]?.string, "café 猫\n\n[Attached image: \(destination.path)]")
        XCTAssertEqual(input["body"]?.string, "café 猫")
        await server.stop()
    }
}

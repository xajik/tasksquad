import Foundation
import Testing
@testable import TaskSquadPortal

@Test func inputFramesPreserveArbitraryUTF8Bytes() throws {
    let source = Data("paste café 猫\n".utf8)
    let frame = try #require(try JSONSerialization.jsonObject(with: PortalTerminalSession.inputFrame(source)) as? [String: String])
    #expect(frame["t"] == "i")
    #expect(Data(base64Encoded: try #require(frame["d"])) == source)
}

@Test func resizeFramesUseRelayProtocolKeys() throws {
    let frame = try #require(try JSONSerialization.jsonObject(with: PortalTerminalSession.resizeFrame(cols: 132, rows: 43)) as? [String: Any])
    #expect(frame["t"] as? String == "r")
    #expect(frame["c"] as? Int == 132)
    #expect(frame["r"] as? Int == 43)
}

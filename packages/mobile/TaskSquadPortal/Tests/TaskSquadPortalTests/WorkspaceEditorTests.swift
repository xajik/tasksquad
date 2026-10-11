import XCTest
@testable import TaskSquadPortal

final class WorkspaceEditorTests: XCTestCase {
    private func error(_ fields: [WorkspaceField], _ values: [String: JSONValue], phases: [PhaseDraft]? = nil, files: [CustomerUpload] = []) -> String? {
        do { _ = try WorkspaceEditor.payload(fields: fields, values: values, phases: phases, files: files); return nil }
        catch { return error.localizedDescription }
    }
    private var conveyor: [WorkspaceField] { WorkspaceField.fields(for: .conveyors) }
    private var conveyorValues: [String: JSONValue] {
        ["subject": .string("s"), "agent_id": .string("a"), "body": .string("b"), "frequency": .string("daily"), "hour": .number(9), "minute": .number(0), "timezone": .string("UTC")]
    }

    func testRequiredAndIntegerFields() {
        XCTAssertEqual(error([.init("subject", "Subject", required: true)], ["subject": .string("  ")]), "Subject is required.")
        XCTAssertEqual(error([.init("n", "Count", .integer)], ["n": .string("1.5")]), "Count must be a whole number.")
        let body = try? WorkspaceEditor.payload(fields: [.init("n", "Count", .integer), .init("o", "Optional", .optionalInteger)], values: ["n": .string("7"), "o": .string("")])
        XCTAssertEqual(body?["n"], .number(7)); XCTAssertEqual(body?["o"], .null)
    }

    func testDatesMustBeInTheFuture() {
        XCTAssertEqual(error([.init("at", "Send at", .date)], ["at": .number(1)]), "Send at must be in the future.")
        XCTAssertNil(error([.init("at", "Send at", .date)], ["at": .number((Date().timeIntervalSince1970 + 3600) * 1000)]))
    }

    func testConveyorSchedules() {
        XCTAssertNil(error(conveyor, conveyorValues))
        var values = conveyorValues; values["hour"] = .number(24)
        XCTAssertEqual(error(conveyor, values), "hour must be between 0 and 23.")
        values = conveyorValues; values["timezone"] = .string("Mars/Base")
        XCTAssertEqual(error(conveyor, values), "Choose a valid time zone.")
        values = conveyorValues; values["timezone"] = .string("")
        XCTAssertEqual(error(conveyor, values), "Time zone is required.")
        values = conveyorValues; values["frequency"] = .string("weekly"); values["day_of_week"] = .string("")
        XCTAssertEqual(error(conveyor, values), "Choose a weekday from 0 to 6.")
        values = conveyorValues; values["frequency"] = .string("monthly"); values["day_of_month"] = .number(32)
        XCTAssertEqual(error(conveyor, values), "day of month must be between 1 and 31.")
        values = conveyorValues; values["repeat_count"] = .number(0)
        XCTAssertEqual(error(conveyor, values), "Maximum runs must be at least 1.")
    }

    func testPhasesSerializeAndValidate() throws {
        var phase = PhaseDraft(); phase.name = "Build"; phase.agent = "a"; phase.retries = 2; phase.autoClose = false
        let body = try WorkspaceEditor.payload(fields: [], values: ["default_sub_agent_id": .string("")], phases: [phase])
        XCTAssertEqual(body["phases"], .array([.object(["name": .string("Build"), "max_retries": .number(2), "auto_close": .bool(false), "harness_agent_id": .string("a")])]))
        XCTAssertNil(body["default_sub_agent_id"], "Empty defaults are omitted")
        XCTAssertEqual(error([], [:], phases: [PhaseDraft()]), "Give every phase a name.")
        XCTAssertEqual(error([], [:], phases: []), "Add a phase with retries between 0 and 10.")
    }

    func testAttachmentLimits() {
        let png = CustomerUpload(name: "a.png", mimeType: "image/png", data: Data(count: 10))
        XCTAssertNil(error([], [:], files: Array(repeating: png, count: 5)))
        XCTAssertNotNil(error([], [:], files: Array(repeating: png, count: 6)))
        XCTAssertNotNil(error([], [:], files: [CustomerUpload(name: "a.pdf", mimeType: "application/pdf", data: Data(count: 10))]))
        XCTAssertNotNil(error([], [:], files: [CustomerUpload(name: "big.png", mimeType: "image/png", data: Data(count: 10 * 1024 * 1024 + 1))]))
    }

    func testStatusPresentationMatchesDesignMapping() {
        XCTAssertEqual(StatusPresentation("waiting_input"), StatusPresentation("waiting_input"))
        XCTAssertEqual(StatusPresentation("waiting_input").label, "Waiting for input")
        XCTAssertEqual(StatusPresentation("wrapping_up").label, "Wrapping up")
        for status in ["running", "done", "idle", "live", "accumulating"] { XCTAssertEqual(StatusPresentation(status).variant, .default, status) }
        for status in ["queued", "waiting_input", "scheduled", "stuck", "wrapping_up"] { XCTAssertEqual(StatusPresentation(status).variant, .secondary, status) }
        for status in ["failed", "error"] { XCTAssertEqual(StatusPresentation(status).variant, .destructive, status) }
        XCTAssertEqual(StatusPresentation("something_new").variant, .outline, "Unknown statuses are neutral")
    }
}

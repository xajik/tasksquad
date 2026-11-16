import XCTest
@testable import TaskSquadPortal

final class RecordActionTests: XCTestCase {
    private func record(_ fields: [String: JSONValue]) -> CustomerRecord { CustomerRecord(.object(fields.merging(["id": .string("r")]) { a, _ in a })) }
    private func kinds(_ section: WorkspaceSection, _ fields: [String: JSONValue] = [:], canManage: Bool = true, isOwner: Bool = true, user: String = "me") -> [RecordAction.Kind] {
        RecordAction.available(section: section, record: record(fields), canManage: canManage, isOwner: isOwner, userID: user).map(\.kind)
    }

    func testOpenTaskOffersCloseCancelAndTerminal() {
        let open = kinds(.inbox, ["status": .string("running"), "session_id": .string("s")])
        XCTAssertEqual(open, [.forward, .logs, .terminal, .tokenSaving, .approve, .reject, .close, .cancel, .delete])
        let done = kinds(.inbox, ["status": .string("done"), "session_id": .string("s")])
        XCTAssertEqual(done, [.forward, .logs, .tokenSaving, .approve, .reject, .delete])
    }

    func testCloseIsConfirmedButNotDestructive() throws {
        let actions = RecordAction.available(section: .inbox, record: record(["status": .string("running")]), canManage: true, isOwner: true, userID: "me")
        let close = try XCTUnwrap(actions.first { $0.kind == .close }), delete = try XCTUnwrap(actions.first { $0.kind == .delete })
        XCTAssertNotNil(close.confirmation); XCTAssertFalse(close.isDestructive)
        XCTAssertTrue(delete.isDestructive)
    }

    func testGradeTogglesOff() {
        let graded = record(["grade": .number(1)])
        XCTAssertEqual(RecordAction.operation(.approve, section: .inbox, project: "p", record: graded)?.body, ["grade": .null])
        XCTAssertEqual(RecordAction.operation(.reject, section: .inbox, project: "p", record: graded)?.body, ["grade": .number(0)])
        XCTAssertTrue(RecordAction.available(section: .inbox, record: graded, canManage: true, isOwner: true, userID: "").first { $0.kind == .approve }!.isOn)
    }

    func testManagementActionsNeedAManagerRole() {
        XCTAssertEqual(kinds(.agents), [.edit, .pause, .createToken, .reset, .delete])
        XCTAssertEqual(kinds(.agents, ["paused": .bool(true)]), [.edit, .resume, .createToken, .reset, .delete])
        XCTAssertEqual(kinds(.agents, canManage: false), [])
        XCTAssertEqual(kinds(.conveyors), [.edit, .runNow, .pause, .delete])
        XCTAssertEqual(kinds(.skills, ["is_default": .bool(true)]), [.duplicate])
        XCTAssertEqual(kinds(.skills), [.edit, .duplicate, .delete])
        XCTAssertEqual(kinds(.planners, canManage: false), [.approve, .reject])
    }

    func testMembersCanLeaveAndOwnersCanRemove() {
        XCTAssertEqual(kinds(.members, ["id": .string("me"), "role": .string("member")]), [.leave])
        XCTAssertEqual(kinds(.members, ["id": .string("me"), "role": .string("owner")]), [])
        XCTAssertEqual(kinds(.members, ["id": .string("other")]), [.delete])
        XCTAssertEqual(kinds(.members, ["id": .string("other")], isOwner: false), [])
    }

    func testNotesArchiveMatchesTheirState() {
        XCTAssertTrue(kinds(.notes).contains(.archive))
        XCTAssertTrue(kinds(.notes, ["archived_at": .number(5)]).contains(.restore))
    }

    func testOperationsUseTheSharedRoutes() {
        let r = record([:])
        XCTAssertEqual(RecordAction.operation(.delete, section: .inbox, project: "p", record: r)?.path, ["tasks", "r"])
        XCTAssertEqual(RecordAction.operation(.delete, section: .notes, project: "p", record: r)?.path, ["teams", "p", "notes", "r"])
        XCTAssertEqual(RecordAction.operation(.closePortal, section: .portals, project: "p", record: r)?.path, ["portals", "r", "close"])
        XCTAssertEqual(RecordAction.operation(.pause, section: .agents, project: "p", record: r)?.path, ["teams", "p", "agents", "r", "pause"])
        XCTAssertNil(RecordAction.operation(.edit, section: .notes, project: "p", record: r))
    }

    func testEverySectionHasOneDestinationAndTheFirstNineHaveShortcuts() {
        XCTAssertEqual(Set(WorkspaceSection.allCases.map(\.destination)), Set(WorkspaceSection.destinations))
        XCTAssertEqual(WorkspaceSection.inbox.shortcutDigit, 1)
        XCTAssertEqual(WorkspaceSection.commands.shortcutDigit, WorkspaceSection.skills.shortcutDigit)
        XCTAssertEqual(Set(WorkspaceSection.destinations.compactMap(\.shortcutDigit)).count, 9)
        XCTAssertTrue(WorkspaceSection.tabs.allSatisfy(WorkspaceSection.destinations.contains))
    }

    func testFilterLabelsAreReadable() {
        XCTAssertEqual(WorkspaceFilter.label("all", any: "Any status"), "Any status")
        XCTAssertEqual(WorkspaceFilter.label("waiting_input", any: ""), "Waiting for input")
        XCTAssertEqual(WorkspaceFilter.label("from-note", any: ""), "From a note")
    }
}

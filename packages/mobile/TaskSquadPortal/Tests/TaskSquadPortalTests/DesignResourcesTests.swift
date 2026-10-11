import XCTest
import TaskSquadDesign

final class DesignResourcesTests: XCTestCase {
    func testSharedBundleShipsVectorSourcesAndCatalog() throws {
        let bundle = try XCTUnwrap(TSQResources.bundle, "TaskSquadDesign resource bundle must be locatable")
        for icon in ["inbox", "terminal", "bot"] {
            XCTAssertNotNil(bundle.url(forResource: icon, withExtension: "svg", subdirectory: TSQResources.vectorFolder + "/Icons"), icon)
        }
        XCTAssertNotNil(bundle.url(forResource: "logo", withExtension: "svg", subdirectory: TSQResources.vectorFolder + "/Brand"))
        XCTAssertNil(bundle.url(forResource: "inbox", withExtension: "sha256", subdirectory: TSQResources.vectorFolder + "/Icons"), "Source digests must not ship")
    }
}

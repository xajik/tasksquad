import XCTest
import TaskSquadCore
import TaskSquadMacPlatform

/// Installs the macOS services the shared code runs on, as the executables do at launch.
class PlatformTestCase: XCTestCase {
    override class func setUp() {
        super.setUp()
        Platform.install(MacPlatform())
    }
}

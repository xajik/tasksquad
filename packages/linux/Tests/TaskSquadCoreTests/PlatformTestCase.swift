import XCTest
import TaskSquadCore
import TaskSquadLinuxPlatform

/// Installs the Linux services the shared code runs on, as `tsq` does at launch.
class PlatformTestCase: XCTestCase {
    override class func setUp() {
        super.setUp()
        Platform.install(LinuxPlatform())
    }
}

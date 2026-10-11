// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TaskSquadPortal",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "TaskSquadPortal", targets: ["TaskSquadPortal"])],
    targets: [
        .target(name: "TaskSquadPortal"),
        .testTarget(name: "TaskSquadPortalTests", dependencies: ["TaskSquadPortal"]),
    ]
)

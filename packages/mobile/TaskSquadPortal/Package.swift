// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "TaskSquadPortal",
    platforms: [.iOS(.v17), .macOS(.v26)],
    products: [
        .library(name: "TaskSquadPortalAPI", targets: ["TaskSquadPortalAPI"]),
        .library(name: "TaskSquadPortal", targets: ["TaskSquadPortal"]),
        .library(name: "TaskSquadDesign", targets: ["TaskSquadDesign"]),
        .library(name: "TaskSquadPortalUI", targets: ["TaskSquadPortalUI"]),
    ],
    targets: [
        // HTTP transport + JSONValue: plain Foundation, also builds on Linux for tsq-core.
        .target(name: "TaskSquadPortalAPI"),
        .target(name: "TaskSquadPortal", dependencies: ["TaskSquadPortalAPI"]),
        .target(name: "TaskSquadDesign", resources: [.copy("Vectors"), .process("Assets.xcassets")]),
        .target(name: "TaskSquadPortalUI", dependencies: ["TaskSquadPortal", "TaskSquadDesign"]),
        .testTarget(name: "TaskSquadPortalTests", dependencies: ["TaskSquadPortal", "TaskSquadDesign"]),
        .testTarget(name: "TaskSquadPortalUITests", dependencies: ["TaskSquadPortalUI", "TaskSquadPortal", "TaskSquadDesign"]),
    ]
)

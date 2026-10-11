// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TaskSquadPortal",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "TaskSquadPortal", targets: ["TaskSquadPortal"]),
        .library(name: "TaskSquadDesign", targets: ["TaskSquadDesign"]),
        .library(name: "TaskSquadPortalUI", targets: ["TaskSquadPortalUI"]),
    ],
    targets: [
        .target(name: "TaskSquadPortal"),
        .target(name: "TaskSquadDesign", resources: [.copy("Vectors"), .process("Assets.xcassets")]),
        .target(name: "TaskSquadPortalUI", dependencies: ["TaskSquadPortal", "TaskSquadDesign"]),
        .testTarget(name: "TaskSquadPortalTests", dependencies: ["TaskSquadPortal", "TaskSquadDesign"]),
        .testTarget(name: "TaskSquadPortalUITests", dependencies: ["TaskSquadPortalUI", "TaskSquadPortal", "TaskSquadDesign"]),
    ]
)

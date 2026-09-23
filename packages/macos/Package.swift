// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TaskSquad",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "TaskSquad", targets: ["TaskSquad"]),
        .library(name: "TaskSquadCore", targets: ["TaskSquadCore"]),
    ],
    targets: [
        .target(name: "TaskSquadCore"),
        .executableTarget(name: "TaskSquad", dependencies: ["TaskSquadCore"]),
        .testTarget(name: "TaskSquadUITests", dependencies: ["TaskSquad", "TaskSquadCore"]),
        .testTarget(name: "TaskSquadCoreTests", dependencies: ["TaskSquadCore"],
                    resources: [.copy("Fixtures")]),
    ]
)

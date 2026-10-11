// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TaskSquad",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "TaskSquad", targets: ["TaskSquad"]),
        .library(name: "TaskSquadCore", targets: ["TaskSquadCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.20.0"),
        .package(path: "../mobile/TaskSquadPortal"),
    ],
    targets: [
        .target(name: "TaskSquadCore", dependencies: [.product(name: "TaskSquadPortal", package: "TaskSquadPortal")],
                resources: [.copy("Resources/Fonts")]),
        .executableTarget(name: "TaskSquad", dependencies: ["TaskSquadCore", .product(name: "SwiftTerm", package: "SwiftTerm"),
                                                             .product(name: "TaskSquadPortal", package: "TaskSquadPortal"),
                                                             .product(name: "TaskSquadDesign", package: "TaskSquadPortal"),
                                                             .product(name: "TaskSquadPortalUI", package: "TaskSquadPortal")],
                          resources: [.copy("Resources")]),
        .testTarget(name: "TaskSquadUITests", dependencies: ["TaskSquad", "TaskSquadCore", .product(name: "TaskSquadPortalUI", package: "TaskSquadPortal")]),
        .testTarget(name: "TaskSquadCoreTests", dependencies: ["TaskSquadCore"],
                    resources: [.copy("Fixtures")]),
    ]
)

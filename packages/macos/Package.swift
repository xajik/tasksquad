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
    ],
    targets: [
        .target(name: "TaskSquadCore"),
        .executableTarget(name: "TaskSquad", dependencies: ["TaskSquadCore", .product(name: "SwiftTerm", package: "SwiftTerm")],
                          resources: [.copy("Resources")]),
        .testTarget(name: "TaskSquadUITests", dependencies: ["TaskSquad", "TaskSquadCore"]),
        .testTarget(name: "TaskSquadCoreTests", dependencies: ["TaskSquadCore"],
                    resources: [.copy("Fixtures")]),
    ]
)

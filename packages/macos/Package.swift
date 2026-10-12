// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "TaskSquad",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "TaskSquad", targets: ["TaskSquad"]),
        .executable(name: "tsq", targets: ["tsq"]),
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.20.0"),
        .package(path: "../mobile/TaskSquadPortal"),
        // Engine and CLI shared with the Linux build.
        .package(path: "../tsq-core"),
    ],
    targets: [
        // macOS implementations of `PlatformServices` (Network, Keychain, CoreText, launchd).
        .target(name: "TaskSquadMacPlatform", dependencies: [.product(name: "TaskSquadCore", package: "tsq-core")], resources: [.copy("Resources/Fonts")]),
        .executableTarget(name: "tsq", dependencies: [.product(name: "TaskSquadCLI", package: "tsq-core"), .product(name: "TaskSquadCore", package: "tsq-core"), "TaskSquadMacPlatform"]),
        .executableTarget(name: "TaskSquad", dependencies: [.product(name: "TaskSquadCore", package: "tsq-core"), .product(name: "TaskSquadCLI", package: "tsq-core"), "TaskSquadMacPlatform",
                                                             .product(name: "SwiftTerm", package: "SwiftTerm"),
                                                             .product(name: "TaskSquadPortal", package: "TaskSquadPortal"),
                                                             .product(name: "TaskSquadDesign", package: "TaskSquadPortal"),
                                                             .product(name: "TaskSquadPortalUI", package: "TaskSquadPortal")],
                          resources: [.copy("Resources")]),
        .testTarget(name: "TaskSquadUITests", dependencies: ["TaskSquad", .product(name: "TaskSquadCore", package: "tsq-core"), "TaskSquadMacPlatform", .product(name: "TaskSquadPortalUI", package: "TaskSquadPortal")]),
        .testTarget(name: "TaskSquadCLITests", dependencies: [.product(name: "TaskSquadCLI", package: "tsq-core"), .product(name: "TaskSquadCore", package: "tsq-core"), "TaskSquadMacPlatform"]),
        // Core and CLI tests: Tests/*/Shared links to packages/tsq-core/Tests/Shared, run here on macOS services.
        .testTarget(name: "TaskSquadCoreTests", dependencies: [.product(name: "TaskSquadCore", package: "tsq-core"), "TaskSquadMacPlatform", .product(name: "TaskSquadPortal", package: "TaskSquadPortal")],
                    resources: [.copy("Shared/Fixtures")]),
    ]
)

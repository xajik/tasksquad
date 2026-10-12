// swift-tools-version: 6.2
import PackageDescription

// The daemon engine and `tsq` CLI shared by every OS build: the same source on
// macOS and Linux, with OS services injected through `PlatformServices`.
// It has no test target of its own: Tests/Shared is compiled by each OS package
// (packages/macos, packages/linux) against that OS's platform implementation.
let package = Package(
    name: "TSQCore",
    platforms: [.macOS(.v26)],
    products: [
        .library(name: "TaskSquadCore", targets: ["TaskSquadCore"]),
        .library(name: "TaskSquadCLI", targets: ["TaskSquadCLI"]),
    ],
    dependencies: [
        .package(path: "../mobile/TaskSquadPortal"),
        // On Apple platforms `import Crypto` re-exports CryptoKit; elsewhere it is BoringSSL.
        .package(url: "https://github.com/apple/swift-crypto.git", "3.10.0"..<"5.0.0"),
    ],
    targets: [
        .target(name: "TaskSquadCore", dependencies: [.product(name: "TaskSquadPortalAPI", package: "TaskSquadPortal"),
                                                      .product(name: "Crypto", package: "swift-crypto")]),
        .target(name: "TaskSquadCLI", dependencies: ["TaskSquadCore"]),
    ]
)

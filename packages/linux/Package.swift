// swift-tools-version: 6.2
import PackageDescription

// The Linux `tsq` (CLI + headless daemon): tsq-core plus the Linux platform layer.
// No UI. Builds only on Linux (glibc now; the static musl SDK later):
//   swift build -c release --product tsq
// Tests/*/Shared are symlinks to tsq-core/Tests/Shared, run against LinuxPlatform.
let package = Package(
    name: "TaskSquadLinux",
    products: [
        .executable(name: "tsq", targets: ["tsq"]),
    ],
    dependencies: [
        .package(path: "../tsq-core"),
    ],
    targets: [
        .target(name: "TaskSquadLinuxPlatform", dependencies: [.product(name: "TaskSquadCore", package: "tsq-core")]),
        .executableTarget(name: "tsq", dependencies: [.product(name: "TaskSquadCLI", package: "tsq-core"),
                                                    .product(name: "TaskSquadCore", package: "tsq-core"), "TaskSquadLinuxPlatform"]),
    ]
)

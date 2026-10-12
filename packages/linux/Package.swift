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
        // Fonts -> packages/daemon/screenshot/assets (the files Go embeds), compiled in so the
        // static binary needs no resource bundle.
        .target(name: "TaskSquadLinuxPlatform", dependencies: [.product(name: "TaskSquadCore", package: "tsq-core")],
                exclude: ["Fonts/OFL.txt"],
                resources: [.embedInCode("Fonts/JetBrainsMono-Regular.ttf"), .embedInCode("Fonts/JetBrainsMono-Bold.ttf")]),
        .executableTarget(name: "tsq", dependencies: [.product(name: "TaskSquadCLI", package: "tsq-core"),
                                                    .product(name: "TaskSquadCore", package: "tsq-core"), "TaskSquadLinuxPlatform"]),
        .testTarget(name: "TaskSquadCoreTests", dependencies: [.product(name: "TaskSquadCore", package: "tsq-core"), "TaskSquadLinuxPlatform"],
                    resources: [.copy("Shared/Fixtures")]),
        .testTarget(name: "TaskSquadCLITests", dependencies: [.product(name: "TaskSquadCLI", package: "tsq-core"),
                                                            .product(name: "TaskSquadCore", package: "tsq-core"), "TaskSquadLinuxPlatform"]),
    ]
)

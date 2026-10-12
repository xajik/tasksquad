import Foundation
import TaskSquadCLI
import TaskSquadCore
import TaskSquadMacPlatform

// The standalone `tsq` command-line build: Go's `tsq` subcommands, and with no
// subcommand the headless daemon. No AppKit or SwiftUI is linked.
Platform.install(MacPlatform())
TaskSquadPaths.prepareEnvironment()
let arguments = Array(CommandLine.arguments.dropFirst())
// Inside TaskSquad.app the bundle's Info.plist carries the release version.
let version = Bundle.main.object(forInfoDictionaryKey: "TSQVersion") as? String ?? TSQBuild.version
let context = CLIContext(version: version)
if TSQCommandLine.handles(arguments) {
    exit(await TSQCommandLine.run(arguments, context: context))
}
exit(await DaemonRunner.run(arguments, context: context))

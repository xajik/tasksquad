import Foundation
import TaskSquadCLI
import TaskSquadCore
import TaskSquadLinuxPlatform

// The Linux `tsq`: Go's `tsq` subcommands, and with no subcommand the headless daemon.
Platform.install(LinuxPlatform())
TaskSquadPaths.prepareEnvironment()
let arguments = Array(CommandLine.arguments.dropFirst())
let context = CLIContext(version: TSQBuild.version)
if TSQCommandLine.handles(arguments) {
    exit(await TSQCommandLine.run(arguments, context: context))
}
exit(await DaemonRunner.run(arguments, context: context))

import AppKit
import Darwin
import SwiftUI
import TaskSquadCLI
import TaskSquadCore
import TaskSquadDesign

if let locale = setlocale(LC_CTYPE, ""), ["C", "POSIX"].contains(String(cString: locale)) {
    // Finder can launch without LANG. Terminal wcwidth still needs UTF-8.
    setlocale(LC_CTYPE, "en_US.UTF-8")
}
let inheritedPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
setenv("PATH", TaskSquadPaths().searchPath(executable: CommandLine.arguments[0], inherited: inheritedPath), 1)
// `--start-engine` starts the local daemon once configuration loads, for
// unattended runs (E2E loops, login items). It only combines with `--config`.
let startEngineAtLaunch = CommandLine.arguments.contains("--start-engine")
let arguments = Array(CommandLine.arguments.dropFirst()).filter { $0 != "--start-engine" }
#if DEBUG
if arguments == ["--preview-customer"] {
    CustomerPreviewApplication.main()
    exit(0)
}
#endif
if TSQCommandLine.handles(arguments) {
    // `tsq <command>`: the same binary as the app, no UI (Go: main.go subcommands).
    exit(await TSQCommandLine.run(arguments))
} else if arguments == ["--version"] || arguments == ["-version"] {
    print("tsq \(Bundle.main.object(forInfoDictionaryKey: "TSQVersion") as? String ?? "dev")")
} else if arguments.first == "--check-config" {
    do {
        let path = arguments.count > 1 ? URL(fileURLWithPath: arguments[1]) : TaskSquadPaths().config
        let config = try DaemonConfiguration.load(from: path)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        FileHandle.standardOutput.write(try encoder.encode(config))
        print()
    } catch {
        FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
        exit(1)
    }
} else if arguments.isEmpty || arguments.first == "--config" {
    TaskSquadApplication.main()
} else {
    FileHandle.standardError.write(Data("This development build does not yet implement this tsq command.\n".utf8))
    exit(2)
}

struct TaskSquadApplication: App {
    @NSApplicationDelegateAdaptor(ApplicationDelegate.self) private var delegate
    @StateObject private var model = ControlPanelModel()
    @StateObject private var customer = CustomerWorkspaceModel()
    var body: some Scene {
        Window("TaskSquad", id: WindowID.main) {
            MainWindow(control: model, customer: customer)
                .frame(minWidth: 900, minHeight: 560)
                .onAppear { delegate.model = model; delegate.customer = customer }
                .task {
                    // Like the Go app: with no configuration, run `tsq init` in Terminal and
                    // relaunch afterwards; otherwise the daemon starts with the app.
                    if !delegate.startedAtLaunch, AppSetup.startIfNeeded(configuration: model.configurationURL, paths: model.paths) {
                        NSApp.terminate(nil); return
                    }
                    await model.load()
                    if !delegate.startedAtLaunch, model.configuration != nil || startEngineAtLaunch {
                        delegate.startedAtLaunch = true
                        await model.startEngine()
                    }
                }
        }
        .defaultSize(width: 1200, height: 760)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandGroup(replacing: .newItem) { }
            CommandGroup(after: .appInfo) {
                Button("Show Configuration in Finder") { model.revealConfiguration() }
            }
            CommandGroup(before: .windowList) { ThisMacCommand() }
        }
        Window("This Mac", id: WindowID.thisMac) {
            ThisMacWindow(control: model)
                .frame(minWidth: 860, minHeight: 520)
                .task { if model.configuration == nil { await model.load() } }
        }
        .defaultSize(width: 1120, height: 720)
        .windowToolbarStyle(.unifiedCompact)
        Settings { SettingsView() }
        MenuBarExtra {
            MenuBarContent(model: model)
        } label: { Image(nsImage: BrandImage.tray) }
    }
}

@MainActor final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    weak var model: ControlPanelModel?
    weak var customer: CustomerWorkspaceModel?
    /// Reopening the window re-runs its `.task`; auto-start happens once.
    var startedAtLaunch = false
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationDidFinishLaunching(_ notification: Notification) {
        AppAppearance.current.apply()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        Task { await customer?.shutdown(); await model.shutdown(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

private struct MenuBarContent: View {
    @ObservedObject var model: ControlPanelModel
    @Environment(\.openWindow) var openWindow
    var body: some View {
        Text(model.loginEmail.map { "👤 " + $0 } ?? "👤 Not logged in")
        Text(model.engineRunning ? model.statsLabel : (model.configuration == nil ? "Configuration unavailable" : "Daemon stopped"))
        Divider()
        Button(model.pullingPaused ? "▶ Resume Pulling" : "⏸ Pause Pulling") { Task { await model.togglePulling() } }
            .disabled(!model.engineRunning)
        Toggle("Run on OS Boot", isOn: Binding(get: { model.runOnLogin }, set: { _ in model.toggleRunOnLogin() }))
        Button("Open Config") { NSWorkspace.shared.open(model.configurationURL) }
        if model.loginEmail != nil { Button("Logout") { Task { await model.logout() } } }
        Divider()
        Button("Open TaskSquad") {
            openWindow(id: WindowID.main)
            NSApp.activate(ignoringOtherApps: true)
        }
        Button("Open This Mac") {
            openWindow(id: WindowID.thisMac)
            NSApp.activate(ignoringOtherApps: true)
        }
        Button(model.engineRunning ? "Stop Daemon" : "Start Daemon") {
            Task { if model.engineRunning { await model.stopEngine() } else { await model.startEngine() } }
        }.disabled(model.engineBusy || (!model.engineRunning && model.configuration == nil))
        Picker("Appearance", selection: Binding(get: { AppAppearance.current }, set: {
            UserDefaults.standard.set($0.rawValue, forKey: AppAppearance.storageKey); $0.apply()
        })) {
            ForEach(AppAppearance.allCases) { Text($0.title).tag($0) }
        }
        Divider()
        Button("Quit TaskSquad") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}

private struct ThisMacCommand: View {
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Button("This Mac") { openWindow(id: WindowID.thisMac) }.keyboardShortcut("m", modifiers: [.command, .shift])
    }
}

/// Go's startAppSetup: the setup wizard is interactive and Finder has no stdin.
enum AppSetup {
    static func startIfNeeded(configuration: URL, paths: TaskSquadPaths) -> Bool {
        guard configuration == paths.config, !FileManager.default.fileExists(atPath: configuration.path),
              let executable = Bundle.main.executableURL?.path, Bundle.main.bundleURL.pathExtension == "app" else { return false }
        func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\"'\"'") + "'" }
        let script = FileManager.default.temporaryDirectory.appendingPathComponent("tasksquad-setup-\(UUID().uuidString).command")
        do {
            try Data("#!/bin/sh\nrm -- \"$0\"\n\(quote(executable)) init && /usr/bin/open -a \(quote(Bundle.main.bundleURL.path))\n".utf8).write(to: script)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: script.path)
            let open = Process()
            open.executableURL = URL(fileURLWithPath: "/usr/bin/open"); open.arguments = ["-a", "Terminal", script.path]
            try open.run(); open.waitUntilExit()
            return open.terminationStatus == 0
        } catch { try? FileManager.default.removeItem(at: script); return false }
    }
}

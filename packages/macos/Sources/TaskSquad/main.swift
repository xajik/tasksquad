import AppKit
import Darwin
import SwiftUI
import TaskSquadCLI
import TaskSquadCore
import TaskSquadDesign
import TaskSquadMacPlatform
import TaskSquadPortal
import UserNotifications

Platform.install(MacPlatform())
if let locale = setlocale(LC_CTYPE, ""), ["C", "POSIX"].contains(String(cString: locale)) {
    // Finder can launch without LANG. Terminal wcwidth still needs UTF-8.
    setlocale(LC_CTYPE, "en_US.UTF-8")
}
TaskSquadPaths.prepareEnvironment()
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
            WorkspaceCommands()
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
        Settings { SettingsView(control: model, customer: customer) }
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
        // The notification centre needs a bundle; `swift run` has none.
        if Bundle.main.bundleIdentifier != nil { UNUserNotificationCenter.current().delegate = self }
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
        Text(model.loginEmail ?? "Not signed in")
        Text(model.engineRunning ? model.statsLabel : (model.configuration == nil ? "Configuration unavailable" : "Daemon stopped"))
        Divider()
        Button("Open TaskSquad") {
            openWindow(id: WindowID.main)
            NSApp.activate(ignoringOtherApps: true)
        }
        Button("Open This Mac") {
            openWindow(id: WindowID.thisMac)
            NSApp.activate(ignoringOtherApps: true)
        }
        Divider()
        Button(model.engineRunning ? "Stop Daemon" : "Start Daemon") {
            Task { if model.engineRunning { await model.stopEngine() } else { await model.startEngine() } }
        }.disabled(model.engineBusy || (!model.engineRunning && model.configuration == nil))
        Button(model.pullingPaused ? "Resume Pulling New Tasks" : "Pause Pulling New Tasks") { Task { await model.togglePulling() } }
            .disabled(!model.engineRunning)
        Toggle("Open at Login", isOn: Binding(get: { model.runOnLogin }, set: { _ in model.toggleRunOnLogin() }))
        Button("Open Configuration File") { NSWorkspace.shared.open(model.configurationURL) }
        Divider()
        SettingsLink { Text("Settings…") }
        Button("Quit TaskSquad") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}

/// Menu-bar commands for the project window. They act on whichever window is
/// in front, and are disabled when that is not the project window.
struct WorkspaceCommands: Commands {
    @FocusedObject private var ui: WorkspaceUI?
    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button(ui?.createTitle ?? "New Task") { ui?.create() }.keyboardShortcut("n").disabled(ui?.canCreate != true)
            Button("New Project…") { ui?.newProject() }.keyboardShortcut("n", modifiers: [.command, .shift]).disabled(ui?.signedIn != true)
        }
        CommandGroup(after: .textEditing) {
            Button("Find") { ui?.searching = true }.keyboardShortcut("f").disabled(ui?.signedIn != true)
        }
        CommandGroup(after: .toolbar) {
            Button("Refresh") { ui?.refresh() }.keyboardShortcut("r").disabled(ui?.signedIn != true)
            Divider()
            ForEach(CustomerSection.destinations) { section in
                if let digit = section.shortcutDigit {
                    Button(section.title) { ui?.select(section) }
                        .keyboardShortcut(KeyEquivalent(Character(String(digit))), modifiers: .command).disabled(ui?.signedIn != true)
                } else {
                    Button(section.title) { ui?.select(section) }.disabled(ui?.signedIn != true)
                }
            }
            Divider()
        }
        CommandMenu("Item") {
            Button("Reply") { ui?.focusReply() }.keyboardShortcut("r", modifiers: [.command, .shift]).disabled(ui?.canReply != true)
            if let ui, let record = ui.selected {
                RecordCommandItems(ui: ui, record: record)
                Divider()
                Button("Open in Web") { ui.model.openInBrowser() }.keyboardShortcut("o", modifiers: [.command, .option])
            } else {
                Button("No Item Selected") { }.disabled(true)
            }
        }
    }
}

/// The selected record's actions as menu-bar items; Delete gets ⌘⌫.
private struct RecordCommandItems: View {
    @ObservedObject var ui: WorkspaceUI
    let record: CustomerRecord
    var body: some View {
        let actions = ui.actions(for: record)
        ForEach(Array([RecordAction.Placement.primary, .secondary, .feedback, .destructive].enumerated()), id: \.offset) { _, placement in
            let group = actions.filter { $0.placement == placement }
            if !group.isEmpty {
                Divider()
                ForEach(group) { action in
                    if action.kind == .delete {
                        Button(action.title) { ui.perform(action, on: record) }.keyboardShortcut(.delete, modifiers: .command).disabled(ui.model.busy)
                    } else {
                        Button((action.isOn ? "✓ " : "") + action.title) { ui.perform(action, on: record) }.disabled(ui.model.busy)
                    }
                }
            }
        }
    }
}

private struct ThisMacCommand: View {
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Button("This Mac") { openWindow(id: WindowID.thisMac) }.keyboardShortcut("m", modifiers: [.command, .shift])
    }
}

extension ApplicationDelegate: UNUserNotificationCenterDelegate {
    /// Clicking a task notification opens that task in the project window.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let task = response.notification.request.identifier
        await MainActor.run {
            customer?.openTask(task)
            NSApp.activate(ignoringOtherApps: true)
            NSApp.windows.first { $0.identifier?.rawValue == WindowID.main }?.makeKeyAndOrderFront(nil)
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
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

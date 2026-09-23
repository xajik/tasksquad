import AppKit
import SwiftUI
import TaskSquadCore
import Darwin

if let locale = setlocale(LC_CTYPE, ""), ["C", "POSIX"].contains(String(cString: locale)) {
    // Finder can launch without LANG. Terminal wcwidth still needs UTF-8.
    setlocale(LC_CTYPE, "en_US.UTF-8")
}
let inheritedPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
setenv("PATH", TaskSquadPaths().searchPath(executable: CommandLine.arguments[0], inherited: inheritedPath), 1)
let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "login" || arguments.first == "logout" {
    exit(await AuthenticationCommands.run(arguments[0]))
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
    var body: some Scene {
        Window("TaskSquad", id: "control-panel") {
            ControlPanel(model: model)
                .frame(minWidth: 850, minHeight: 540)
                .onAppear { delegate.model = model }
                .task { await model.load() }
        }
        .defaultSize(width: 1100, height: 720)
        .commands {
            CommandGroup(replacing: .newItem) { }
            CommandGroup(after: .appInfo) {
                Button("Show Configuration in Finder") { model.revealConfiguration() }
            }
        }
        MenuBarExtra("TaskSquad", systemImage: "person.3.sequence.fill") {
            MenuBarContent(model: model)
        }
    }
}

@MainActor final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    weak var model: ControlPanelModel?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model else { return .terminateNow }
        Task { await model.shutdown(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

private struct MenuBarContent: View {
    @ObservedObject var model: ControlPanelModel
    @Environment(\.openWindow) var openWindow
    var body: some View {
        Text(model.configuration.map { "\($0.agents.count) configured agents" } ?? "Configuration unavailable")
        Text(model.engineRunning ? "Engine running" : "Engine stopped")
        Button("Open Control Panel") {
            openWindow(id: "control-panel")
            NSApp.activate(ignoringOtherApps: true)
        }
        Divider()
        Button("Quit TaskSquad") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}

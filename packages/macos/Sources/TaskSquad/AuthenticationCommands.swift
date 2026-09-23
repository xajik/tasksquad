import AppKit
import TaskSquadCore

@MainActor enum AuthenticationCommands {
    static func run(_ command: String) async -> Int32 {
        do {
            let config = try? DaemonConfiguration.load(from: TaskSquadPaths().config)
            // Keep the existing Go login command's fallback URL for unconfigured machines.
            let apiURL = config?.server.url ?? "https://tasksquad.ai"
            let dashboardURL = config?.dashboardURL ?? "https://tasksquad.ai"
            let authentication = Authentication(apiURL: apiURL, firebaseAPIKey: config?.firebase.apiKey ?? "")
            if command == "logout" {
                try await authentication.logout()
                print("Logged out.")
                return 0
            }
            let flow = try await LoginFlow.begin(dashboardURL: dashboardURL)
            print("Opening browser for login...")
            print("If the browser doesn't open, visit:\n  \(flow.browserURL.absoluteString)\n")
            NSWorkspace.shared.open(flow.browserURL)
            let callback = try await flow.result()
            try await authentication.acceptLogin(idToken: callback.idToken, refreshToken: callback.refreshToken, email: callback.email)
            print("Logged in as \(callback.email)")
            return 0
        } catch {
            FileHandle.standardError.write(Data("\(command) failed: \(error.localizedDescription)\n".utf8))
            return 1
        }
    }
}

import SwiftUI
import TaskSquadPortal

@main
struct TaskSquadApp: App {
    @AppStorage("mobile.appearance") private var appearance = "system"
    @StateObject private var auth = MobileAuthStore()

    private static var fixtureAPI: CustomerAPI? {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "--ui-test-api"), args.count > index + 1,
           let url = URL(string: args[index + 1]), url.host == "127.0.0.1" {
            return CustomerAPI(baseURL: url) { _ in "fixture-token" }
        }
        #endif
        return nil
    }
    private var colorScheme: ColorScheme? {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "--ui-test-appearance"), args.count > index + 1 { return args[index + 1] == "dark" ? .dark : .light }
        #endif
        return appearance == "dark" ? .dark : appearance == "light" ? .light : nil
    }
    var body: some Scene {
        WindowGroup {
            Group {
                if let fixture = Self.fixtureAPI {
                    PortalHomeView(auth: auth, api: fixture)
                } else if auth.token != nil {
                    PortalHomeView(auth: auth)
                } else {
                    MobileSignInView(auth: auth)
                }
            }
            .modifier(MobileFixtureTypeSize())
            .tint(MobileTheme.primary)
            .foregroundStyle(MobileTheme.foreground)
            .preferredColorScheme(colorScheme)
            .task { auth.restore() }
        }
    }
}

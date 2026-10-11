import SwiftUI

@main
struct TaskSquadApp: App {
    @StateObject private var auth = MobileAuthStore()

    var body: some Scene {
        WindowGroup {
            Group {
                if ProcessInfo.processInfo.arguments.contains("--ui-test-demo") {
                    PortalHomeView(auth: auth, token: "demo")
                } else if let token = auth.token {
                    PortalHomeView(auth: auth, token: token)
                } else {
                    MobileSignInView(auth: auth)
                }
            }
            .task { auth.restore() }
        }
    }
}

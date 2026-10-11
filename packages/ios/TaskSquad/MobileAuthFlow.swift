import AuthenticationServices
import CryptoKit
import Foundation
import Security
import SwiftUI
import TaskSquadPortal

@MainActor
final class MobileAuthStore: ObservableObject {
    @Published private(set) var token: String?
    @Published var error: String?
    @Published private(set) var signingIn = false
    private var credential: SavedMobileToken?
    private var generation = UUID()
    private let keychain = MobileTokenStore()
    private var webSession: ASWebAuthenticationSession?

    func restore() {
        guard token == nil else { return }
        credential = keychain.read()
        if let credential, credential.expiresAt > Date().timeIntervalSince1970 * 1000 { token = credential.token }
        else { keychain.delete(); credential = nil }
    }

    func accessToken(forceRefresh: Bool) throws -> String {
        guard let credential, credential.expiresAt > Date().timeIntervalSince1970 * 1000, !forceRefresh else {
            invalidate(); throw PortalAPIError(status: 401, message: "Your session expired. Please sign in again.")
        }
        return credential.token
    }

    func invalidate() {
        generation = UUID(); webSession?.cancel(); webSession = nil; signingIn = false
        keychain.delete(); credential = nil; token = nil
        MobileDraftStore.clear()
    }

    func signIn(presentation: MobileAuthPresenter) async {
        guard !signingIn else { return }
        signingIn = true; error = nil
        let attempt = UUID(); generation = attempt
        do {
            let verifier = try Self.randomString(count: 64)
            let state = try Self.randomString(count: 32)
            let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
            let callback = "tasksquad-portal://oauth/callback"
            var components = URLComponents(url: Self.dashboardURL.appendingPathComponent("mobile/authorize"), resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "redirect_uri", value: callback),
                                     URLQueryItem(name: "code_challenge", value: challenge),
                                     URLQueryItem(name: "code_challenge_method", value: "S256"),
                                     URLQueryItem(name: "state", value: state)]
            let session = ASWebAuthenticationSession(url: components.url!, callbackURLScheme: "tasksquad-portal") { [weak self] url, failure in
                guard let self else { return }
                Task { @MainActor in
                    guard self.generation == attempt else { return }
                    self.webSession = nil
                    defer { self.signingIn = false }
                    if let failure { self.error = failure.localizedDescription; return }
                    guard let url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
                          parts.host == "oauth", parts.path == "/callback",
                          let values = parts.queryItems,
                          values.first(where: { $0.name == "state" })?.value == state,
                          let code = values.first(where: { $0.name == "code" })?.value else {
                        self.error = "Sign-in response could not be verified."; return
                    }
                    do {
                        let api = PortalAPI(baseURL: Self.apiURL, token: { _ in throw URLError(.userAuthenticationRequired) })
                        let result = try await api.exchangeAuthorizationCode(code, verifier: verifier)
                        guard self.generation == attempt else { return }
                        let saved = SavedMobileToken(token: result.token, expiresAt: result.expiresAt)
                        try self.keychain.save(saved)
                        self.credential = saved; self.token = result.token
                    } catch { self.error = error.localizedDescription }
                }
            }
            session.presentationContextProvider = presentation
            session.prefersEphemeralWebBrowserSession = false
            guard session.start() else { throw URLError(.cannotLoadFromNetwork) }
            webSession = session
        } catch { self.error = error.localizedDescription; signingIn = false }
    }

    func signOut() async {
        let previous = token
        invalidate()
        if let previous {
            let api = PortalAPI(baseURL: Self.apiURL, token: { _ in previous })
            try? await api.revokeCurrentToken()
        }
    }

    static var apiURL: URL { URL(string: Bundle.main.object(forInfoDictionaryKey: "TSQAPIBaseURL") as? String ?? "https://api.tasksquad.ai")! }
    static var dashboardURL: URL { URL(string: Bundle.main.object(forInfoDictionaryKey: "TSQDashboardURL") as? String ?? "https://tasksquad.ai")! }
    private static func randomString(count: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: (count * 3 + 3) / 4)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        return String(Data(bytes).base64URLEncodedString().prefix(count))
    }
}

private struct SavedMobileToken: Codable { let token: String; let expiresAt: Double }

private struct MobileTokenStore {
    @MainActor private var service: String { "ai.tasksquad.mobile." + SHA256.hash(data: Data(MobileAuthStore.apiURL.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined() }
    @MainActor func read() -> SavedMobileToken? {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecAttrAccount as String: "cli-token",
                                    kSecReturnData as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitOne]
        query[kSecAttrSynchronizable as String] = false
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(SavedMobileToken.self, from: data)
    }
    @MainActor func save(_ token: SavedMobileToken) throws {
        delete()
        let data = try JSONEncoder().encode(token)
        let status = SecItemAdd([kSecClass as String: kSecClassGenericPassword,
                                 kSecAttrService as String: service,
                                 kSecAttrAccount as String: "cli-token",
                                 kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                 kSecValueData as String: data] as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
    @MainActor func delete() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                       kSecAttrService as String: service,
                       kSecAttrAccount as String: "cli-token"] as CFDictionary)
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

@MainActor
final class MobileAuthPresenter: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

struct MobileSignInView: View {
    @ObservedObject var auth: MobileAuthStore
    @StateObject private var presenter = MobileAuthPresenter()
    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "terminal.fill").font(.system(size: 42)).foregroundStyle(.tint)
            Text("TaskSquad").font(.largeTitle.bold())
            Text("Manage tasks, projects and remote agent sessions.").foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button { Task { await auth.signIn(presentation: presenter) } } label: {
                Label("Continue to sign in", systemImage: "person.crop.circle").frame(maxWidth: .infinity)
            }.buttonStyle(.borderedProminent).controlSize(.large).disabled(auth.signingIn)
            if let error = auth.error { Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("auth-error") }
        }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

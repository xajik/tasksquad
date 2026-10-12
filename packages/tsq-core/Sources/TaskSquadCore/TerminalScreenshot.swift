import Foundation

/// Renders a tmux pane (ANSI colors and attributes kept) to PNG, matching Go's
/// packages/daemon/screenshot. Rendering is OS-specific (`PlatformServices.screenshot`).
public enum TerminalScreenshot {
    /// Captures and renders a pane; scrollbackLines > 0 also includes history.
    public static func capture(session: String, scrollbackLines: Int = 0, tmux: TmuxConnection = TmuxConnection()) async throws -> Data {
        try await Platform.current.screenshot(session: session, scrollbackLines: scrollbackLines, tmux: tmux)
    }
}

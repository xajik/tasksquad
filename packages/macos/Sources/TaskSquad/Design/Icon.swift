import AppKit
import SwiftUI

/// Lucide icons shared with the web portal. The SVGs are vendored by
/// `scripts/vendor-icons.mjs`; add a case there and here together.
enum LucideIcon: String, CaseIterable {
    case inbox, monitor, fileText = "file-text", `repeat`, layers, shieldAlert = "shield-alert", bookOpen = "book-open"
    case database, bot, users, settings, bookMarked = "book-marked", logOut = "log-out", plus, refreshCw = "refresh-cw"
    case search, terminal, folder, x, play, square, listChecks = "list-checks", scrollText = "scroll-text", fileCog = "file-cog"
    case wrench, circleAlert = "circle-alert", externalLink = "external-link", copy, check, paperclip
    case messageSquare = "message-square", messagesSquare = "messages-square", user, sparkles, zap, circleCheck = "circle-check"
    case circle, ellipsis, download, clock, info, chevronDown = "chevron-down", chevronRight = "chevron-right", braces
    case network, circleX = "circle-x", folderPlus = "folder-plus", squareTerminal = "square-terminal"
    case triangleAlert = "triangle-alert", fileCode = "file-code", thumbsUp = "thumbs-up", thumbsDown = "thumbs-down"
    case pencil, trash = "trash-2", send, laptop, sun, moon, sunMoon = "sun-moon", chartColumn = "chart-column"

    @MainActor private static var cache: [String: NSImage] = [:]
    @MainActor var image: NSImage { Self.load("Icons/" + rawValue) }
    @MainActor static func load(_ name: String, template: Bool = true) -> NSImage {
        if let image = cache[name] { return image }
        let parts = name.split(separator: "/").map(String.init)
        let url = resourceBundle?.url(forResource: parts[parts.count - 1], withExtension: "svg",
                                      subdirectory: (["Resources"] + parts.dropLast()).joined(separator: "/"))
        let image = url.flatMap(NSImage.init(contentsOf:)) ?? NSImage(size: NSSize(width: 24, height: 24))
        image.isTemplate = template
        cache[name] = image
        return image
    }

    /// SwiftPM's generated `Bundle.module` calls `fatalError` when the bundle is
    /// missing, so a packaging mistake would crash at launch. Look it up the
    /// same way (app `Contents/Resources`, next to the executable, next to a
    /// test bundle) but degrade to blank icons instead.
    private static let resourceBundle: Bundle? = {
        let name = "TaskSquad_TaskSquad.bundle"
        let roots = [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent()]
            + Bundle.allBundles.map { $0.bundleURL.deletingLastPathComponent() }
        for root in roots.compactMap({ $0 }) {
            if let bundle = Bundle(url: root.appendingPathComponent(name)) { return bundle }
        }
        NSLog("TaskSquad: %@ not found; icons will be blank", name)
        return nil
    }()
}

/// A Lucide icon rendered as a template image, so it takes `foregroundStyle`
/// exactly like the web's `className="h-4 w-4"` icons take `currentColor`.
struct Icon: View {
    let icon: LucideIcon
    var size: CGFloat = 16
    /// Only stores values, so it is usable outside the main actor (e.g. `Label` builders).
    nonisolated init(_ icon: LucideIcon, size: CGFloat = 16) { self.icon = icon; self.size = size }
    var body: some View {
        Image(nsImage: icon.image).renderingMode(.template).resizable().interpolation(.high)
            .frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// The TaskSquad hex logo, same artwork as the web sidebar (`tasksquad-dark.svg`).
struct BrandLogo: View {
    var size: CGFloat = 20
    var body: some View {
        Image(nsImage: LucideIcon.load("Brand/logo", template: false)).resizable().interpolation(.high)
            .frame(width: size, height: size).accessibilityLabel("TaskSquad")
    }
}

enum BrandImage {
    /// Menu bar template icon, the same hex art as the Go daemon's tray icon.
    @MainActor static var tray: NSImage {
        let image = LucideIcon.load("Brand/tray").copy() as! NSImage
        image.size = NSSize(width: 18, height: 18); image.isTemplate = true
        return image
    }
}

extension Label where Title == Text, Icon == TaskSquad.Icon {
    init(_ title: String, icon: LucideIcon) {
        self.init { Text(title) } icon: { TaskSquad.Icon(icon) }
    }
}

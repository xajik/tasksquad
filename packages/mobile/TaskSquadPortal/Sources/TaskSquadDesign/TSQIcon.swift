import SwiftUI
#if os(macOS)
import AppKit
#endif

/// A Lucide icon that takes `foregroundStyle` like the web's `currentColor`
/// icons. `name` is the Lucide file name, e.g. `circle-alert`.
///
/// iOS reads the template PDFs from the asset catalog, which Xcode always
/// compiles. macOS loads the bundled SVGs instead: command-line SwiftPM
/// toolchains (as on CI runners) may copy `Assets.xcassets` uncompiled, which
/// would leave catalog images blank in the shipped app.
public struct TSQIcon: View {
    let name: String
    let size: CGFloat
    public init(_ name: String, size: CGFloat = 16) { self.name = name; self.size = size }
    public var body: some View {
        image.renderingMode(.template).resizable().interpolation(.high)
            .frame(width: size, height: size).accessibilityHidden(true)
    }
    private var image: Image {
        #if os(macOS)
        Image(nsImage: Self.vector(name))
        #else
        Image("TSQ-" + name, bundle: TSQResources.bundle)
        #endif
    }

    #if os(macOS)
    @MainActor private static var cache: [String: NSImage] = [:]
    @MainActor static func vector(_ name: String) -> NSImage {
        if let image = cache[name] { return image }
        let url = TSQResources.bundle?.url(forResource: name, withExtension: "svg", subdirectory: TSQResources.vectorFolder + "/Icons")
        let image = url.flatMap(NSImage.init(contentsOf:)) ?? NSImage(size: NSSize(width: 24, height: 24))
        image.isTemplate = true
        cache[name] = image
        return image
    }
    #endif
}

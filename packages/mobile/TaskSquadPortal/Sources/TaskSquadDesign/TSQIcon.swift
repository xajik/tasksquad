import SwiftUI

/// A Lucide icon from the shared asset catalog (template PDF), so it takes
/// `foregroundStyle` like the web's `currentColor` icons on every platform.
/// `name` is the Lucide file name, e.g. `circle-alert`.
public struct TSQIcon: View {
    let name: String
    let size: CGFloat
    public init(_ name: String, size: CGFloat = 16) { self.name = name; self.size = size }
    public var body: some View {
        Image("TSQ-" + name, bundle: TSQResources.bundle).renderingMode(.template).resizable().interpolation(.high)
            .frame(width: size, height: size).accessibilityHidden(true)
    }
}

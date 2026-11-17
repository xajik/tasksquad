import SwiftUI

/// Liquid Glass for the controls layer: surfaces that float above content, such
/// as the reply bar, a pending-permission prompt or the sign-in card. Content
/// (messages, records, Markdown) stays on plain surfaces, as Apple's guidance
/// asks, so glass never sits on glass.
public extension View {
    /// A floating glass surface. Corners are concentric with the window or
    /// screen corners where the surface sits against them, and `radius` elsewhere.
    func tsqGlass(tint: Color? = nil, interactive: Bool = false, radius: CGFloat = 16) -> some View {
        glassEffect(Glass.regular.tint(tint).interactive(interactive), in: TSQGlassShape(radius: radius))
    }
    /// Lets nearby glass surfaces blend into one another as they move together.
    func tsqGlassContainer(spacing: CGFloat = 12) -> some View {
        GlassEffectContainer(spacing: spacing) { self }
    }
}

public struct TSQGlassShape: Shape {
    var radius: CGFloat
    public init(radius: CGFloat = 16) { self.radius = radius }
    public func path(in rect: CGRect) -> Path {
        ConcentricRectangle(corners: .concentric(minimum: .fixed(radius))).path(in: rect)
    }
}

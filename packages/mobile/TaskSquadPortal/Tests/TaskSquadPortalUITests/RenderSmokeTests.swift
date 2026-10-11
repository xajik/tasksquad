#if os(macOS)
import XCTest
import SwiftUI
import TaskSquadDesign
import TaskSquadPortal
import TaskSquadPortalUI

/// Offscreen renders of the shared components in both appearances. They catch
/// layout traps and, via the icon check, a design bundle that failed to ship.
@MainActor final class RenderSmokeTests: XCTestCase {
    private func render<V: View>(_ view: V, dark: Bool, width: CGFloat = 480) throws -> CGImage {
        let renderer = ImageRenderer(content: view.frame(width: width).environment(\.colorScheme, dark ? .dark : .light))
        renderer.scale = 2
        return try XCTUnwrap(renderer.cgImage, "render failed")
    }
    private func opaquePixels(_ image: CGImage) -> Int {
        let width = image.width, height = image.height
        var data = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return stride(from: 3, to: data.count, by: 4).filter { data[$0] > 0 }.count
    }

    func testIconsDrawFromTheSharedAssetCatalog() throws {
        for name in ["inbox", "terminal", "circle-alert", "monitor"] {
            let image = try render(TSQIcon(name, size: 24).foregroundStyle(.black), dark: false, width: 24)
            XCTAssertGreaterThan(opaquePixels(image), 20, "\(name) rendered blank; is TaskSquadPortal_TaskSquadDesign.bundle present?")
        }
        let missing = try render(TSQIcon("no-such-icon", size: 24).foregroundStyle(.black), dark: false, width: 24)
        XCTAssertEqual(opaquePixels(missing), 0, "The pixel check must be able to detect a blank icon")
    }

    func testSharedComponentsRenderInBothAppearances() throws {
        for dark in [false, true] {
            let content = VStack(spacing: 12) {
                TSQPageHeader("Inbox", subtitle: "Product") { Button("Create") {}.buttonStyle(.tsqPrimary) }
                TSQCard { HStack { TSQStatusDot(active: true); TSQBadge(status: "waiting_input"); TSQBadge(status: "failed") } }
                TSQErrorBanner("Close rejected", identifier: "detail-error") {}
                MarkdownContent("# Title\n\n| A | B |\n|-|-|\n| 1 | 2 |\n\n```swift\nlet a = 1\n```")
                TSQEmptyState(icon: "inbox", title: "No inbox", message: "Choose another project or create a new item.").frame(height: 240)
            }.padding().background(TSQTheme.background)
            let image = try render(content, dark: dark)
            XCTAssertGreaterThan(image.height, 400, "components collapsed (dark: \(dark))")
        }
    }
}
#endif

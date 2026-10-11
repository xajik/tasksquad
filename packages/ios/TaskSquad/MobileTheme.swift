import SwiftUI
import UIKit

import TaskSquadDesign

typealias MobileTheme = TSQTheme
typealias MobilePrimaryButtonStyle = TSQButtonStyle

struct MobileIcon: View {
    let name: String
    var size: CGFloat = 20
    var body: some View { Image("TSQ-" + name, bundle: TSQResources.bundle).renderingMode(.template).resizable().frame(width: size, height: size).accessibilityHidden(true) }
}

struct MobileFixtureTypeSize: ViewModifier {
    func body(content: Content) -> some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-large-text") { content.environment(\.dynamicTypeSize, .accessibility3) }
        else { content }
        #else
        content
        #endif
    }
}

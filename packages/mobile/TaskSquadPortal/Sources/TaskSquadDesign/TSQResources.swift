import Foundation

public enum TSQResources {
    /// Copied SVG sources. Not named `Resources`: a flat iOS bundle containing a
    /// `Resources/` directory fails codesign as an unrecognized bundle format.
    public static let vectorFolder = "Vectors"

    /// SwiftPM's generated `Bundle.module` calls `fatalError` when the bundle is
    /// missing, so a packaging mistake would crash at launch. Look it up the same
    /// way (app resources, app root, next to the executable or a test bundle) but
    /// degrade to blank icons instead.
    public static let bundle: Bundle? = {
        let name = "TaskSquadPortal_TaskSquadDesign.bundle"
        let roots = [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent()]
            + Bundle.allBundles.map { $0.bundleURL.deletingLastPathComponent() }
        for root in roots.compactMap({ $0 }) {
            if let bundle = Bundle(url: root.appendingPathComponent(name)) { return bundle }
        }
        NSLog("TaskSquad: %@ not found; icons will be blank", name)
        return nil
    }()
}

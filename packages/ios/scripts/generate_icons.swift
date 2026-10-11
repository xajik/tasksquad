import AppKit
import Foundation
import ImageIO
import CryptoKit

// Convert the same Lucide/brand SVG sources used by macOS into UIKit PDF assets.
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("../mobile/TaskSquadPortal/Sources/TaskSquadDesign/Vectors")
let output = root.appendingPathComponent("../mobile/TaskSquadPortal/Sources/TaskSquadDesign/Assets.xcassets")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
try Data("{\"info\":{\"author\":\"xcode\",\"version\":1}}".utf8).write(to: output.appendingPathComponent("Contents.json"))
// Source digests live outside the copied Vectors folder so they never ship in the bundle.
let hashes = root.appendingPathComponent("../mobile/TaskSquadPortal/IconHashes")
try FileManager.default.createDirectory(at: hashes, withIntermediateDirectories: true)
final class VectorView: NSView {
    let image: NSImage
    init(image: NSImage, size: CGFloat) { self.image = image; super.init(frame: NSRect(x: 0, y: 0, width: size, height: size)) }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) { image.draw(in: bounds) }
}
for input in try FileManager.default.contentsOfDirectory(at: source.appendingPathComponent("Icons"), includingPropertiesForKeys: nil).filter({ $0.pathExtension == "svg" }).sorted(by: { $0.path < $1.path }) {
    let name = input.deletingPathExtension().lastPathComponent
    let folder = output.appendingPathComponent("TSQ-" + name + ".imageset")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let pdf = folder.appendingPathComponent("icon.pdf")
    let digest = Data(SHA256.hash(data: try Data(contentsOf: input)))
    let hashFile = hashes.appendingPathComponent(name + ".sha256")
    if !FileManager.default.fileExists(atPath: pdf.path) || digest != (try? Data(contentsOf: hashFile)) {
        guard let image = NSImage(contentsOf: input) else { fatalError("Missing SVG: " + input.path) }
        try VectorView(image: image, size: 24).dataWithPDF(inside: NSRect(x: 0, y: 0, width: 24, height: 24)).write(to: pdf)
        try digest.write(to: hashFile)
        let contents: [String: Any] = ["images": [["filename": "icon.pdf", "idiom": "universal"]], "properties": ["preserves-vector-representation": true, "template-rendering-intent": "template"], "info": ["author": "xcode", "version": 1]]
        try JSONSerialization.data(withJSONObject: contents, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent("Contents.json"))
    }
}

// Full-colour brand logo for in-app use (TSQLogo); not a template image.
let logoSource = source.appendingPathComponent("Brand/logo.svg")
let logoFolder = output.appendingPathComponent("TSQBrand-logo.imageset")
let logoDigest = Data(SHA256.hash(data: try Data(contentsOf: logoSource)))
let logoHash = hashes.appendingPathComponent("brand-logo.sha256")
if !FileManager.default.fileExists(atPath: logoFolder.appendingPathComponent("logo.pdf").path) || logoDigest != (try? Data(contentsOf: logoHash)) {
    guard let image = NSImage(contentsOf: logoSource) else { fatalError("Missing SVG: " + logoSource.path) }
    try FileManager.default.createDirectory(at: logoFolder, withIntermediateDirectories: true)
    try VectorView(image: image, size: 64).dataWithPDF(inside: NSRect(x: 0, y: 0, width: 64, height: 64)).write(to: logoFolder.appendingPathComponent("logo.pdf"))
    try logoDigest.write(to: logoHash)
    let contents: [String: Any] = ["images": [["filename": "logo.pdf", "idiom": "universal"]], "properties": ["preserves-vector-representation": true, "template-rendering-intent": "original"], "info": ["author": "xcode", "version": 1]]
    try JSONSerialization.data(withJSONObject: contents, options: [.prettyPrinted, .sortedKeys]).write(to: logoFolder.appendingPathComponent("Contents.json"))
}

// Drop imagesets (and digests) whose source SVG was removed.
let svgNames = Set(try FileManager.default.contentsOfDirectory(atPath: source.appendingPathComponent("Icons").path).filter { $0.hasSuffix(".svg") }.map { String($0.dropLast(4)) })
for set in try FileManager.default.contentsOfDirectory(atPath: output.path) where set.hasPrefix("TSQ-") && set.hasSuffix(".imageset") {
    let name = String(set.dropFirst(4).dropLast(9))
    if !svgNames.contains(name) {
        try FileManager.default.removeItem(at: output.appendingPathComponent(set))
        try? FileManager.default.removeItem(at: hashes.appendingPathComponent(name + ".sha256"))
    }
}

let iconFolder = root.appendingPathComponent("TaskSquad/Assets.xcassets/AppIcon.appiconset")
try FileManager.default.createDirectory(at: iconFolder, withIntermediateDirectories: true)
let iconPNG = iconFolder.appendingPathComponent("AppIcon.png")
if !FileManager.default.fileExists(atPath: iconPNG.path) {
    guard let logo = NSImage(contentsOf: source.appendingPathComponent("Brand/logo.svg")),
          let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 4096, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fatalError("Could not render brand icon") }
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()
    logo.draw(in: NSRect(x: 128, y: 128, width: 768, height: 768))
    NSGraphicsContext.restoreGraphicsState()
    guard let image = context.makeImage(), let destination = CGImageDestinationCreateWithURL(iconPNG as CFURL, "public.png" as CFString, 1, nil) else { fatalError("Could not encode brand icon") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fatalError("Could not save brand icon") }
}
let iconContents: [String: Any] = ["images": [["filename": "AppIcon.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"]], "info": ["author": "xcode", "version": 1]]
try JSONSerialization.data(withJSONObject: iconContents, options: [.prettyPrinted, .sortedKeys]).write(to: iconFolder.appendingPathComponent("Contents.json"))

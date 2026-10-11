import AppKit
import Foundation
import ImageIO

// Convert the same Lucide/brand SVG sources used by macOS into UIKit PDF assets.
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("../macos/Sources/TaskSquad/Resources")
let output = root.appendingPathComponent("TaskSquad/Assets.xcassets")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
try Data("{\"info\":{\"author\":\"xcode\",\"version\":1}}".utf8).write(to: output.appendingPathComponent("Contents.json"))
final class VectorView: NSView {
    let image: NSImage
    init(image: NSImage, size: CGFloat) { self.image = image; super.init(frame: NSRect(x: 0, y: 0, width: size, height: size)) }
    required init?(coder: NSCoder) { fatalError() }
    override func draw(_ dirtyRect: NSRect) { image.draw(in: bounds) }
}
for name in ["terminal", "plus", "refresh-cw", "chevron-right", "ellipsis", "user", "inbox"] {
    let input = source.appendingPathComponent("Icons/" + name + ".svg")
    let folder = output.appendingPathComponent("TSQ-" + name + ".imageset")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let pdf = folder.appendingPathComponent("icon.pdf")
    if !FileManager.default.fileExists(atPath: pdf.path) {
        guard let image = NSImage(contentsOf: input) else { fatalError("Missing SVG: " + input.path) }
        try VectorView(image: image, size: 24).dataWithPDF(inside: NSRect(x: 0, y: 0, width: 24, height: 24)).write(to: pdf)
        let contents: [String: Any] = ["images": [["filename": "icon.pdf", "idiom": "universal"]], "properties": ["preserves-vector-representation": true, "template-rendering-intent": "template"], "info": ["author": "xcode", "version": 1]]
        try JSONSerialization.data(withJSONObject: contents, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent("Contents.json"))
    }
}

let iconFolder = output.appendingPathComponent("AppIcon.appiconset")
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

import AppKit

// Rasterizes the shared brand mark (same file the web app's favicon/PWA icons
// come from — see packages/portal/public/tasksquad-light.svg) at each size
// iconutil needs. The source SVG already has Apple's rounded-square shape
// baked in, matching how modern macOS app icons are authored.
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
let sourcePath = CommandLine.arguments[2]
guard let source = NSImage(contentsOfFile: sourcePath) else {
    FileHandle.standardError.write(Data("Icon.swift: couldn't load source image at \(sourcePath)\n".utf8))
    exit(1)
}
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                      isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let extent = CGFloat(pixels)
        source.draw(in: NSRect(x: 0, y: 0, width: extent, height: extent),
                    from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent(name))
    }
}

// Draws the disk image's window background at 1x and 2x, in one TIFF.
// Run from apple/: swift scripts/dmg-background.swift scripts/dmg-background.tiff
// Stay with light colors. Finder keeps its dark labels on a pictured window, even in Dark Mode.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let width = 660.0
let height = 400.0
// dmg-layout.applescript puts the icons at x 170 and 480, y 170. The folder's artwork is about
// 20 points wider than the app icon's, so those x values and the chevron's leave the same visible
// gap on each side of the chevron, about 70 points, with the whole group centered on the window.
let chevronCenter = CGPoint(x: 320, y: 170)

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ hex: UInt32) -> CGColor {
    CGColor(
        colorSpace: srgb,
        components: [
            CGFloat((hex >> 16) & 0xFF) / 255,
            CGFloat((hex >> 8) & 0xFF) / 255,
            CGFloat(hex & 0xFF) / 255,
            1,
        ])!
}

func draw(scale: Int) -> CGImage {
    let context = CGContext(
        data: nil, width: Int(width) * scale, height: Int(height) * scale,
        bitsPerComponent: 8, bytesPerRow: 0, space: srgb,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    // Top-left origin, in points, the same way Finder positions icons.
    context.translateBy(x: 0, y: height * CGFloat(scale))
    context.scaleBy(x: CGFloat(scale), y: -CGFloat(scale))

    // Paper, the color of the website.
    context.setFillColor(color(0xFDFBF7))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))

    // The hill from the app icon, kept below the icon labels.
    context.setFillColor(color(0xECEFE8))
    context.move(to: CGPoint(x: 0, y: 352))
    context.addCurve(
        to: CGPoint(x: width, y: 334),
        control1: CGPoint(x: 190, y: 306),
        control2: CGPoint(x: 430, y: 300))
    context.addLine(to: CGPoint(x: width, y: height))
    context.addLine(to: CGPoint(x: 0, y: height))
    context.closePath()
    context.fillPath()

    // The chevron from the app to Applications.
    context.setStrokeColor(color(0x0A2F1D))
    context.setLineWidth(7)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    context.move(to: CGPoint(x: chevronCenter.x - 12, y: chevronCenter.y - 26))
    context.addLine(to: CGPoint(x: chevronCenter.x + 12, y: chevronCenter.y))
    context.addLine(to: CGPoint(x: chevronCenter.x - 12, y: chevronCenter.y + 26))
    context.strokePath()

    return context.makeImage()!
}

guard CommandLine.arguments.count == 2 else {
    fatalError("Usage: dmg-background.swift <output.tiff>")
}
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let destination = CGImageDestinationCreateWithURL(
    output as CFURL, UTType.tiff.identifier as CFString, 2, nil)!
for scale in [1, 2] {
    let dpi = 72 * scale
    let properties: [CFString: Any] = [
        kCGImagePropertyDPIWidth: dpi,
        kCGImagePropertyDPIHeight: dpi,
        // LZW
        kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFCompression: 5],
    ]
    CGImageDestinationAddImage(destination, draw(scale: scale), properties as CFDictionary)
}
guard CGImageDestinationFinalize(destination) else {
    fatalError("Couldn't write \(output.path)")
}

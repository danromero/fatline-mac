import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import Fatline

/// Pictures are prepared on the device before they go to a network.
final class NetworkImageTests: XCTestCase {
    /// A solid picture written as `type`, with a GPS location and an orientation when asked.
    private func picture(width: Int, height: Int, type: UTType, frames: Int = 1, located: Bool = false, orientation: Int? = nil) -> Data {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(red: 0.1, green: 0.4, blue: 0.2, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = context.makeImage()!
        let output = NSMutableData()
        let destination = CGImageDestinationCreateWithData(output, type.identifier as CFString, frames, nil)!
        var properties: [CFString: Any] = [:]
        if located { properties[kCGImagePropertyGPSDictionary] = [kCGImagePropertyGPSLatitude: 51.5, kCGImagePropertyGPSLongitude: 0.12] }
        if let orientation { properties[kCGImagePropertyOrientation] = orientation }
        for _ in 0..<frames { CGImageDestinationAddImage(destination, image, properties as CFDictionary) }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return output as Data
    }

    private func properties(_ data: Data) -> [CFString: Any] {
        let source = CGImageSourceCreateWithData(data as CFData, nil)!
        return CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
    }

    func testShrinksALargePhotoAndDropsWhereItWasTaken() throws {
        let image = try XCTUnwrap(NetworkImage(data: picture(width: 4000, height: 3000, type: .jpeg, located: true)))
        XCTAssertEqual(image.type, "image/jpeg")
        let written = properties(image.data)
        XCTAssertEqual(written[kCGImagePropertyPixelWidth] as? Int, NetworkImage.maxSide)
        XCTAssertEqual(written[kCGImagePropertyPixelHeight] as? Int, 1536)
        XCTAssertNil(written[kCGImagePropertyGPSDictionary], "the location stays behind")
    }

    func testTurnsAPhotoUpright() throws {
        // Orientation 6 means the camera was turned, so the picture is shown taller than it's stored.
        let image = try XCTUnwrap(NetworkImage(data: picture(width: 300, height: 200, type: .jpeg, orientation: 6)))
        let written = properties(image.data)
        XCTAssertEqual(written[kCGImagePropertyPixelWidth] as? Int, 200)
        XCTAssertEqual(written[kCGImagePropertyPixelHeight] as? Int, 300)
        XCTAssertNil(written[kCGImagePropertyOrientation].flatMap { $0 as? Int }.flatMap { $0 == 1 ? nil : $0 })
    }

    func testKeepsAMovingGIFsFrames() throws {
        let gif = picture(width: 40, height: 40, type: .gif, frames: 3)
        let image = try XCTUnwrap(NetworkImage(data: gif))
        XCTAssertEqual(image.type, "image/gif")
        XCTAssertEqual(frames(image.data), 3)
    }

    private func frames(_ data: Data) -> Int {
        CGImageSourceCreateWithData(data as CFData, nil).map(CGImageSourceGetCount) ?? 0
    }

    /// A GIF from ImageIO with a comment, an XMP block, and a loop block put in after its header, and
    /// something after its trailer.
    private func taggedGIF() throws -> (gif: Data, header: Int) {
        var bytes = [UInt8](picture(width: 40, height: 40, type: .gif, frames: 3))
        let packed = bytes[10]
        let header = 13 + (packed & 0x80 != 0 ? 3 * (1 << (Int(packed & 0x07) + 1)) : 0)
        let comment: [UInt8] = [0x21, 0xFE, 11] + Array("secret note".utf8) + [0]
        let xmp: [UInt8] = [0x21, 0xFF, 11] + Array("XMP DataXMP".utf8) + [9] + Array("<x:where>".utf8) + [0]
        let loop: [UInt8] = [0x21, 0xFF, 11] + Array("NETSCAPE2.0".utf8) + [3, 1, 5, 0, 0]
        bytes.insert(contentsOf: comment + xmp + loop, at: header)
        XCTAssertEqual(bytes.last, 0x3B)
        bytes += Array("after the end".utf8)
        return (Data(bytes), header)
    }

    func testAMovingGIFLosesCommentsAndApplicationBlocksButKeepsItsFramesAndLoop() throws {
        let (gif, _) = try taggedGIF()
        XCTAssertEqual(frames(gif), 3)
        let image = try XCTUnwrap(NetworkImage(data: gif))
        XCTAssertEqual(image.type, "image/gif")
        XCTAssertEqual(frames(image.data), 3)
        for gone in ["secret note", "XMP DataXMP", "<x:where>", "after the end"] {
            XCTAssertNil(image.data.firstRange(of: Data(gone.utf8)), gone)
        }
        let loop = Data([0x21, 0xFF, 11] + Array("NETSCAPE2.0".utf8) + [3, 1, 5, 0, 0])
        XCTAssertNotNil(image.data.firstRange(of: loop), "the loop count stays")
        XCTAssertEqual(image.data.last, 0x3B)
    }

    func testCleaningAGIFIsTheSameTwice() throws {
        let once = NetworkImage.stripGIF(try taggedGIF().gif)
        XCTAssertEqual(NetworkImage.stripGIF(once), once)
    }

    func testACutOffGIFStopsWhereADecoderWould() throws {
        let (gif, header) = try taggedGIF()
        let cut = gif.prefix(header + 5)
        let cleaned = NetworkImage.stripGIF(Data(cut))
        XCTAssertEqual(cleaned, Data(cut.prefix(header)) + Data([0x3B]), "the cut-off comment goes")
    }

    func testRefusesWhatIsntAPicture() {
        XCTAssertNil(NetworkImage(data: Data("not a picture".utf8)))
    }
}

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A picture ready for a network: turned upright, no more than 2,048 pixels on its long side, and
/// written fresh, so where it was taken and the rest of its metadata stay behind. A GIF that moves
/// keeps its frames, within the network's 10 MB limit, and loses its comments and application blocks.
struct NetworkImage: Identifiable, Sendable {
    let id = UUID()
    let data: Data
    /// image/jpeg, image/png, or image/gif, as the network takes them.
    let type: String
    /// A small copy for the composer.
    let thumbnail: CGImage

    static let maxSide = 2048
    static let maxBytes = 10 * 1024 * 1024
    /// Sharp at the composer's size: 128 points at 2x on the Mac, 140 at 3x on iPhone, cropped square.
    #if os(macOS)
    private static let thumbnailSide = 256
    #else
    private static let thumbnailSide = 640
    #endif
    /// The formats people pick or paste. Anything else is refused rather than decoded.
    private static let readable: Set<String> = [
        UTType.jpeg.identifier, UTType.png.identifier, UTType.gif.identifier, UTType.heic.identifier,
        UTType.webP.identifier, "public.avif", UTType.tiff.identifier,
    ]

    /// Nil if the data isn't a picture this can read.
    init?(data: Data) {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let format = CGImageSourceGetType(source) as String?, Self.readable.contains(format),
              let thumbnail = Self.shrink(source, to: Self.thumbnailSide) else { return nil }
        self.thumbnail = thumbnail
        if format == UTType.gif.identifier, CGImageSourceGetCount(source) > 1, data.count <= Self.maxBytes {
            self.data = Self.stripGIF(data)
            type = "image/gif"
            return
        }
        guard let upright = Self.shrink(source, to: Self.maxSide) else { return nil }
        let keepsTransparency = upright.alphaInfo != .none && upright.alphaInfo != .noneSkipFirst && upright.alphaInfo != .noneSkipLast
            && format == UTType.png.identifier
        guard let written = Self.write(upright, as: keepsTransparency ? .png : .jpeg) else { return nil }
        self.data = written
        type = keepsTransparency ? "image/png" : "image/jpeg"
    }

    /// Reads the file at `url`, if it's a picture.
    init?(contentsOf url: URL) {
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
        self.init(data: data)
    }

    /// The first frame, upright, no more than `side` pixels on its long side.
    private static func shrink(_ source: CGImageSource, to side: Int) -> CGImage? {
        CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: side,
        ] as CFDictionary)
    }

    /// Writes only the pixels: no EXIF, GPS, or other properties come along.
    private static func write(_ image: CGImage, as type: UTType) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil) else { return nil }
        let options: [CFString: Any] = type == .jpeg ? [kCGImageDestinationLossyCompressionQuality: 0.82] : [:]
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination), output.length <= maxBytes else { return nil }
        return output as Data
    }

    // MARK: GIF

    private static let netscape = Array("NETSCAPE2.0".utf8)

    /// A GIF without its comments or application blocks, which carry XMP, color profiles, and whatever
    /// else an editor puts there, the same way the network's server cleans one (`stripGIF` in
    /// `network/src/server/imagebytes.ts`). The NETSCAPE2.0 block, which says how many times to loop,
    /// stays, rebuilt from its loop count alone. Images, graphic control, which times each frame, and
    /// plain text stay. Anything after the trailer goes, and so does anything this can't read, where a
    /// decoder would stop too.
    static func stripGIF(_ data: Data) -> Data {
        let bytes = [UInt8](data)
        let headerEnd = 13 + colorTableSize(bytes.count > 10 ? bytes[10] : 0)
        var out = Array(bytes.prefix(headerEnd))
        var at = headerEnd
        while at < bytes.count {
            let start = at
            let label: Int
            let end: Int?
            if bytes[at] == 0x2C, at + 10 <= bytes.count {
                // An image: its descriptor, a local color table, the LZW code size, then its data.
                label = -1
                end = blocksEnd(bytes, from: at + 10 + colorTableSize(bytes[at + 9]) + 1)
            } else if bytes[at] == 0x21, at + 2 <= bytes.count {
                label = Int(bytes[at + 1])
                end = blocksEnd(bytes, from: at + 2)
            } else {
                break
            }
            guard let end else { break }
            switch label {
            case 0xFF: if let loop = loopBlock(Array(bytes[(start + 2)..<end])) { out += loop }
            case 0xFE: break
            default: out += bytes[start..<end]
            }
            at = end
        }
        out.append(0x3B)
        return Data(out)
    }

    /// The bytes a color table takes, from the packed field that says whether there is one and its size.
    private static func colorTableSize(_ packed: UInt8) -> Int {
        packed & 0x80 != 0 ? 3 * (1 << (Int(packed & 0x07) + 1)) : 0
    }

    /// Where a run of data sub-blocks ends, just past the empty one that closes it, or nil if the file ends first.
    private static func blocksEnd(_ bytes: [UInt8], from: Int) -> Int? {
        var at = from
        while at < bytes.count {
            let size = Int(bytes[at])
            at += 1 + size
            if size == 0 { return at }
        }
        return nil
    }

    /// The NETSCAPE2.0 block made again from just its loop count, or nil for any other application block.
    private static func loopBlock(_ blocks: [UInt8]) -> [UInt8]? {
        // An 11-byte name, then a 3-byte sub-block: 1, and the count, low byte first.
        guard blocks.count >= 16, blocks[0] == 11, Array(blocks[1...11]) == netscape, blocks[12] == 3, blocks[13] == 1 else { return nil }
        return [0x21, 0xFF, 11] + netscape + [3, 1, blocks[14], blocks[15], 0]
    }
}

import ImageIO
import SwiftUI

extension FeedCast {
    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Cast text with its web links made active. The server leaves a link out of `links` when the
    /// text already has it, so this is the only way to open those. Each link opens the address its
    /// own text spells out, and nothing else in the text changes.
    static func linkedText(_ text: String) -> AttributedString {
        var linked = AttributedString(text)
        let matches = linkDetector?.matches(in: text, range: NSRange(text.startIndex..., in: text)) ?? []
        // Each link is a nested piece of text, so a cast of nothing but links can't be allowed to make thousands.
        for match in matches.prefix(20) {
            guard var url = match.url, let scheme = url.scheme?.lowercased(),
                  scheme == "https" || scheme == "http", let host = url.host()?.lowercased(),
                  // A host in another alphabet can look just like a familiar one, so it stays plain text.
                  host.allSatisfy(\.isASCII), !host.split(separator: ".").contains(where: { $0.hasPrefix("xn--") }),
                  let range = Range(match.range, in: linked) else { continue }
            // The detector assumes http for a bare address. Only an address written with http keeps it.
            if scheme == "http", let written = Range(match.range, in: text), !text[written].lowercased().hasPrefix("http:"),
               let secure = URL(string: "https" + url.absoluteString.dropFirst(4)) {
                url = secure
            }
            linked[range].link = url
            linked[range][AttributeScopes.SwiftUIAttributes.UnderlineStyleAttribute.self] = .single
        }
        return linked
    }
}

/// Downloads and shrinks avatars and cast pictures. Shrunk images stay in memory so a row scrolled back
/// into view draws at its final size, and the downloads themselves are cached on disk between launches.
/// A cast's author picks these addresses, so a download and the image inside it both have a size limit.
@MainActor
enum CastImages {
    private final class Entry {
        let image: CGImage
        init(_ image: CGImage) { self.image = image }
    }

    /// A redirect gets the same check as the address in the cast, or a host could use one to get around it.
    final class Redirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
            request.url.flatMap { FeedCast.imageURL($0.absoluteString) } == nil ? nil : request
        }
    }

    nonisolated private static let maxDownloadBytes = 25_000_000
    nonisolated private static let maxSourcePixels = 100_000_000
    /// The formats people post. The system can read dozens more, like camera RAW, and each one is more
    /// decoding code that a stranger's file could reach.
    nonisolated private static let formats: Set<String> = [
        "public.jpeg", "public.png", "com.compuserve.gif", "org.webmproject.webp", "public.heic", "public.avif"
    ]
    private static let memory: NSCache<NSString, Entry> = {
        let cache = NSCache<NSString, Entry>()
        cache.totalCostLimit = Platform.imageMemoryLimit
        return cache
    }()
    private static var loading: [String: Task<CGImage?, Never>] = [:]
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 60
        configuration.urlCache = URLCache(memoryCapacity: 0, diskCapacity: Platform.imageDiskLimit, directory: nil)
        return URLSession(configuration: configuration, delegate: Redirects(), delegateQueue: nil)
    }()

    private static func key(_ url: URL, _ maxPixels: Int) -> String { "\(maxPixels) \(url.absoluteString)" }

    static func cached(_ url: URL, maxPixels: Int) -> CGImage? {
        memory.object(forKey: key(url, maxPixels) as NSString)?.image
    }

    static func load(_ url: URL, maxPixels: Int) async -> CGImage? {
        if let found = cached(url, maxPixels: maxPixels) { return found }
        let key = key(url, maxPixels)
        if let running = loading[key] { return await running.value }
        let session = session
        let task = Task.detached(priority: .utility) { () -> CGImage? in
            guard let data = await download(url, session: session) else { return nil }
            return decode(data, maxPixels: maxPixels)
        }
        loading[key] = task
        let image = await task.value
        loading[key] = nil
        if let image {
            memory.setObject(Entry(image), forKey: key as NSString, cost: image.bytesPerRow * image.height)
        }
        return image
    }

    /// Reads as it goes, so a huge file is dropped at the limit instead of filling memory first.
    nonisolated private static func download(_ url: URL, session: URLSession) async -> Data? {
        guard let (bytes, response) = try? await session.bytes(from: url) else { return nil }
        defer { bytes.task.cancel() }
        guard (response as? HTTPURLResponse)?.statusCode == 200, response.expectedContentLength <= maxDownloadBytes else { return nil }
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count > maxDownloadBytes { return nil }
            }
        } catch {
            return nil
        }
        return data
    }

    nonisolated static func decode(_ data: Data, maxPixels: Int) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source), formats.contains(type as String),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width.multipliedReportingOverflow(by: height).partialValue <= maxSourcePixels else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels
        ] as CFDictionary)
    }
}

import Foundation

/// What a page says about itself, read from its Open Graph tags or its title.
struct LinkPreview: Sendable, Equatable {
    var title: String?
    var description: String?

    private static let maxBytes = 512 * 1024
    @MainActor private static var cache: [URL: LinkPreview] = [:]
    /// No cookies and no cache, so a previewed site can't recognize this device from one preview to
    /// the next, and a redirect gets the same check as the link itself.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 15
        return URLSession(configuration: configuration, delegate: CastImages.Redirects(), delegateQueue: nil)
    }()

    /// The first web address in the text, as `https`. Plain `http` stays text, since networks only carry secure links.
    static func firstLink(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        for match in detector.matches(in: text, range: range) {
            guard let url = match.url, let found = Range(match.range, in: text) else { continue }
            let typed = text[found].lowercased()
            if url.scheme == "https" { return url }
            // A bare address like example.com/menu reads as http. Fatline gives it https.
            if url.scheme == "http", !typed.hasPrefix("http:"), var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
                parts.scheme = "https"
                if let secure = parts.url { return secure }
            }
        }
        return nil
    }

    /// Only HTTPS to a named public host, as for pictures, so typing a link can't make this device call
    /// something on its own network.
    @MainActor
    static func load(_ url: URL) async -> LinkPreview? {
        if let cached = cache[url] { return cached }
        guard FeedCast.imageURL(url.absoluteString) != nil, let preview = await fetch(url) else { return nil }
        cache[url] = preview
        return preview
    }

    /// Reads the page up to 512 KB and stops there, off the main thread, then reads its tags.
    private static func fetch(_ url: URL) async -> LinkPreview? {
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.setValue("text/html", forHTTPHeaderField: "accept")
        guard let (bytes, response) = try? await session.bytes(for: request) else { return nil }
        defer { bytes.task.cancel() }
        guard (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false else { return nil }
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count >= maxBytes { break }
            }
        } catch {
            guard !data.isEmpty else { return nil }
        }
        guard let html = text(data) else { return nil }
        return parse(html)
    }

    /// UTF-8, allowing for a character cut in two at the end, or else Latin-1.
    private static func text(_ data: Data) -> String? {
        for cut in 0...min(3, data.count) {
            if let text = String(data: data.dropLast(cut), encoding: .utf8) { return text }
        }
        return String(data: data, encoding: .isoLatin1)
    }

    static func parse(_ html: String) -> LinkPreview {
        func meta(_ names: [String]) -> String? {
            for name in names {
                let pattern = #"<meta[^>]+(?:property|name)\s*=\s*["']"# + NSRegularExpression.escapedPattern(for: name) + #"["'][^>]*>"#
                guard let tag = html.range(of: pattern, options: [.regularExpression, .caseInsensitive]).map({ String(html[$0]) }),
                      let content = tag.range(of: #"content\s*=\s*(["'])(.*?)\1"#, options: .regularExpression).map({ String(tag[$0]) })
                else { continue }
                let value = content.replacingOccurrences(of: #"^content\s*=\s*["']|["']$"#, with: "", options: .regularExpression)
                if let clean = clean(value) { return clean }
            }
            return nil
        }
        let title = meta(["og:title", "twitter:title"]) ?? html
            .range(of: #"(?<=<title>)[^<]+"#, options: [.regularExpression, .caseInsensitive])
            .flatMap { clean(String(html[$0])) }
        return LinkPreview(title: title, description: meta(["og:description", "twitter:description", "description"]))
    }

    private static func clean(_ text: String) -> String? {
        let decoded = text
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&#x27;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return decoded.isEmpty ? nil : decoded
    }
}

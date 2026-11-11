import ImageIO
import SwiftUI

/// A cast's age, which ticks while the feed stays open so a new post doesn't read Now for minutes.
/// On a Mac, resting the pointer on it shows the full date in its place.
private struct CastTime: View {
    let cast: FeedCast
    #if os(macOS)
    @State private var hovering = false
    #endif

    private var fullDate: String { cast.date.formatted(date: .abbreviated, time: .shortened) }

    var body: some View {
        TimelineView(.everyMinute) { context in
            Text(label(at: context.date))
                .font(FatlineStyle.body)
                .foregroundStyle(FatlineStyle.secondary)
                .fixedSize()
                .accessibilityLabel(fullDate)
        }
        #if os(macOS)
        .onHover { hovering = $0 }
        #endif
    }

    private func label(at now: Date) -> String {
        #if os(macOS)
        if hovering { return fullDate }
        #endif
        return cast.shortAge(at: now)
    }
}

/// A cast's text, built from plain text so nothing in a cast is read as Markdown.
private struct CastBodyText: View {
    let text: String

    var body: some View {
        #if os(macOS)
        styled(Self.markedText(FeedCast.linkedText(text)))
            .modifier(CastLinkHotspots())
        #else
        styled(Text(FeedCast.linkedText(text)))
        #endif
    }

    private func styled(_ text: Text) -> some View {
        text
            .font(FatlineStyle.body)
            .lineSpacing(FatlineStyle.bodyLineSpacing)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.disabled)
    }

    #if os(macOS)
    /// Rebuilds the text piece by piece so each link can be found again once the text is laid out.
    private static func markedText(_ linked: AttributedString) -> Text {
        var result = Text(verbatim: "")
        for run in linked.runs {
            var piece = Text(AttributedString(linked[run.range]))
            if let url = run.link { piece = piece.customAttribute(CastLinkAttribute(url: url)) }
            result = Text("\(result)\(piece)")
        }
        return result
    }
    #endif
}

#if os(macOS)
private struct CastLinkAttribute: TextAttribute {
    let url: URL
}

/// SwiftUI gives text links no pointing-hand cursor on a Mac, so an invisible area over each piece
/// of a link shows the hand and opens the link.
private struct CastLinkHotspots: ViewModifier {
    @Environment(\.openURL) private var openURL

    private struct Hotspot: Identifiable {
        let id: Int
        let url: URL
        let rect: CGRect
    }

    func body(content: Content) -> some View {
        content.overlayPreferenceValue(Text.LayoutKey.self) { layouts in
            GeometryReader { proxy in
                ForEach(hotspots(in: layouts, proxy: proxy)) { spot in
                    // A button, so the link can be reached from the keyboard and by VoiceOver.
                    Button { openURL(spot.url) } label: {
                        Color.clear.contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .frame(width: spot.rect.width, height: spot.rect.height)
                    .position(x: spot.rect.midX, y: spot.rect.midY)
                    .pointerStyle(.link)
                    .accessibilityLabel("Open \(FeedCast.label(for: spot.url))")
                }
            }
        }
    }

    private func hotspots(in layouts: Text.LayoutKey.Value, proxy: GeometryProxy) -> [Hotspot] {
        var found: [Hotspot] = []
        for anchored in layouts {
            let origin = proxy[anchored.origin]
            for line in anchored.layout {
                for run in line {
                    guard let attribute = run[CastLinkAttribute.self] else { continue }
                    let rect = run.typographicBounds.rect.offsetBy(dx: origin.x, dy: origin.y)
                    found.append(Hotspot(id: found.count, url: attribute.url, rect: rect))
                }
            }
        }
        return found
    }
}
#endif

/// The author's picture, or their initials until it loads or when there isn't one.
private struct CastAvatar: View {
    let url: URL?
    let handle: String
    @State private var loaded: CGImage?

    private static let maxPixels = 128

    var body: some View {
        let image = loaded ?? url.flatMap { CastImages.cached($0, maxPixels: Self.maxPixels) }
        Group {
            if let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
            } else {
                Text(String(handle.filter(\.isLetter).prefix(2)).uppercased())
                    .font(FatlineStyle.metaStrong)
                    .foregroundStyle(FatlineStyle.secondary)
            }
        }
        .frame(width: FatlineStyle.avatarSize, height: FatlineStyle.avatarSize)
        .background(FatlineStyle.quiet)
        .clipShape(.circle)
        .task(id: url) {
            guard let url else { return }
            loaded = await CastImages.load(url, maxPixels: Self.maxPixels)
        }
    }
}

/// A picture attached to a cast. Clicking it opens the full image in the browser.
private struct CastPicture: View {
    let url: URL
    @State private var loaded: CGImage?
    @State private var failed = false

    private static let maxPixels = 1400
    private static let placeholderRatio: CGFloat = 4 / 3
    /// The tallest a picture's box gets. A taller picture is shown whole inside it.
    private static let tallestRatio: CGFloat = 4 / 5

    var body: some View {
        let image = loaded ?? CastImages.cached(url, maxPixels: Self.maxPixels)
        Link(destination: url) {
            if failed && image == nil {
                Text("Image unavailable")
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.secondary)
                    .underline()
            } else {
                FatlineStyle.quiet
                    .aspectRatio(image.map(Self.ratio) ?? Self.placeholderRatio, contentMode: .fit)
                    .overlay {
                        if let image {
                            Image(decorative: image, scale: 1)
                                .resizable()
                                .interpolation(.high)
                                .scaledToFit()
                        }
                    }
                    .clipShape(.rect(cornerRadius: 10))
                    .contentShape(.rect)
            }
        }
        .buttonStyle(.plain)
        #if os(macOS)
        .pointerStyle(.link)
        #endif
        .accessibilityLabel("Open image")
        .task(id: url) {
            guard image == nil else { return }
            loaded = await CastImages.load(url, maxPixels: Self.maxPixels)
            failed = loaded == nil
        }
    }

    private static func ratio(_ image: CGImage) -> CGFloat {
        max(CGFloat(image.width) / CGFloat(max(image.height, 1)), tallestRatio)
    }
}

struct CastRow: View {
    let cast: FeedCast
    let handle: String

    /// On a Mac the links inside a cast's text are separate controls, which combining would hide.
    private var hasTextLinks: Bool {
        #if os(macOS)
        FeedCast.linkedText(cast.text).runs.contains { $0.link != nil }
        #else
        false
        #endif
    }

    var body: some View {
        let links = cast.webLinks
        let images = cast.imageURLs
        HStack(alignment: .top, spacing: FatlineStyle.avatarGap) {
            CastAvatar(url: cast.avatarURL, handle: handle)
                .padding(.top, FatlineStyle.avatarTopInset)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: handle)
                        .font(FatlineStyle.bodyStrong)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    CastTime(cast: cast)
                }
                if !cast.text.isEmpty {
                    CastBodyText(text: cast.text)
                }
                ForEach(images, id: \.self) { url in
                    CastPicture(url: url)
                        .padding(.vertical, 4)
                }
                ForEach(links, id: \.self) { url in
                    Link(destination: url) {
                        // Two lines always fit a host this short, and a longer one gets as many as it needs.
                        Text(verbatim: FeedCast.label(for: url))
                            .font(FatlineStyle.body)
                            .underline()
                            .lineLimit((url.host()?.count ?? 0) > 30 ? nil : 2)
                            .truncationMode(.tail)
                    }
                    .tint(FatlineStyle.action)
                    .foregroundStyle(FatlineStyle.action)
                    #if os(macOS)
                    .pointerStyle(.link)
                    #endif
                }
                if let quote = cast.quote {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: quote.handle)
                            .font(FatlineStyle.metaStrong)
                        Text(verbatim: quote.text)
                            .font(FatlineStyle.meta)
                            .lineLimit(8)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(FatlineStyle.secondary)
                    .padding(.leading, FatlineStyle.avatarGap)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(FatlineStyle.line).frame(width: 2)
                    }
                    .padding(.top, 4)
                }
            }
        }
        .padding(.horizontal, FatlineStyle.gutter)
        .padding(.vertical, FatlineStyle.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The long-press preview lifts the row off the feed, so it carries the feed's paper with it.
        .background(FatlineStyle.paper)
        .contentShape(.rect)
        .accessibilityElement(children: links.isEmpty && images.isEmpty && !hasTextLinks ? .combine : .contain)
    }
}

/// Stays above the feed until the problem clears, because a feed that's quietly old looks like a quiet
/// day. Clicking or tapping it asks again. It uses the same columns as a cast row, with the mark where an avatar goes.
struct FeedProblemBanner: View {
    let problem: FeedModel.Problem
    let lastChecked: Date?
    let checking: Bool
    let retry: () -> Void

    var body: some View {
        Button(action: retry) {
            HStack(alignment: .top, spacing: FatlineStyle.avatarGap) {
                Image(systemName: "exclamationmark")
                    .font(FatlineStyle.markGlyph)
                    .foregroundStyle(FatlineStyle.actionInk)
                    .frame(width: FatlineStyle.avatarSize, height: FatlineStyle.avatarSize)
                    .background(FatlineStyle.action, in: .circle)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(FatlineStyle.bodyStrong)
                        .foregroundStyle(FatlineStyle.ink)
                    TimelineView(.periodic(from: .now, by: 30)) { context in
                        Text(checking ? "Checking…" : detail(now: context.date))
                            .font(FatlineStyle.meta)
                            .foregroundStyle(FatlineStyle.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, FatlineStyle.gutter)
            .padding(.vertical, FatlineStyle.rowPadding)
            .background(FatlineStyle.quiet)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(checking)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Checks for new posts")
        .accessibilityIdentifier("feed-problem")
    }

    private var title: String {
        switch problem {
        case .paused, .limitReached: "Feed paused"
        case .unreachable: "Can’t reach the server"
        case .refused: "Feed stopped"
        }
    }

    private func detail(now: Date) -> String {
        let age = lastChecked.map { Self.age(now.timeIntervalSince($0)) }
        switch problem {
        case .paused:
            return (age.map { "Last updated \($0) ago. " } ?? "") + "New posts will appear when it’s back. \(Platform.pressVerb) to check."
        case .unreachable:
            return (age.map { "Showing posts from \($0) ago. " } ?? "") + "\(Platform.pressVerb) to try again."
        case .limitReached:
            return (age.map { "Showing posts from \($0) ago. " } ?? "") + "Limit reached. Try again later."
        case .refused:
            let next = Connection.isSetByLaunch ? "\(Platform.pressVerb) to try again." : "Check Connection in Settings."
            return (age.map { "Showing posts from \($0) ago. " } ?? "") + "The server turned down the request. \(next)"
        }
    }

    static func age(_ seconds: TimeInterval) -> String {
        let minutes = max(1, Int(seconds / 60))
        if minutes < 60 { return "\(minutes) min" }
        if minutes < 1440 { return "\(minutes / 60) hr" }
        let days = minutes / 1440
        return days == 1 ? "1 day" : "\(days) days"
    }
}

struct CastDivider: View {
    var body: some View {
        FatlineDivider(inset: FatlineStyle.gutter)
    }
}

/// Sits above the newest cast seen on the last visit, when there are newer ones above it.
struct FeedMarker: View {
    var body: some View {
        Text("Left off here")
            .font(FatlineStyle.metaStrong)
            .foregroundStyle(FatlineStyle.action)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, FatlineStyle.textColumn)
            .padding(.trailing, FatlineStyle.gutter)
            .padding(.vertical, 8)
            .accessibilityIdentifier("feed-marker")
        CastDivider()
    }
}

/// A status line inside a list. It starts on the same column as cast text.
struct FeedMessage: View {
    let text: String

    var body: some View {
        Text(text)
            .font(FatlineStyle.meta)
            .foregroundStyle(FatlineStyle.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, FatlineStyle.textColumn)
            .padding(.trailing, FatlineStyle.gutter)
            .padding(.vertical, FatlineStyle.rowPadding)
    }
}

/// A brief confirmation, or why a post couldn't be confirmed.
struct PostToast {
    let id = UUID()
    let detail: String?
    var confirmation = "Sent"
    var title: String { detail == nil ? confirmation : "Post not confirmed" }
}

struct FeedToastView: View {
    let toast: PostToast

    var body: some View {
        HStack(alignment: .top, spacing: FatlineStyle.textColumn - FatlineStyle.gutter - 12 - 20) {
            Image(systemName: toast.detail == nil ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .font(FatlineStyle.markGlyph)
                .frame(width: 20, height: 20)
                .foregroundStyle(toast.detail == nil ? FatlineStyle.action : FatlineStyle.danger)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(toast.title)
                    .font(FatlineStyle.bodyStrong)
                    .frame(minHeight: 20, alignment: .leading)
                if let detail = toast.detail {
                    Text(detail)
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.secondary)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FatlineStyle.quiet, in: .rect(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14).strokeBorder(FatlineStyle.line)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("post-toast")
    }
}

import SwiftUI

/// What every drawing of a network's mark shares: its letter and its picture.
enum NetworkMarkImage {
    static func letter(_ name: String) -> String {
        String(name.first.map(String.init) ?? "?").uppercased()
    }

    /// One size for every mark, so they share a cached copy: sharp at 76 points on a Retina screen.
    static let iconPixels = 256

    /// A network's picture link, if it's one the app will load: HTTPS on a public host.
    static func iconURL(_ link: String?) -> URL? {
        link.flatMap(FeedCast.imageURL)
    }

    /// The picture, if a mark on screen has loaded it already.
    @MainActor static func cached(_ icon: String?) -> CGImage? {
        iconURL(icon).flatMap { CastImages.cached($0, maxPixels: iconPixels) }
    }
}

/// A network's mark: its picture, or its first letter on a rounded square until the picture loads or
/// when it has none.
struct NetworkMark: View {
    let name: String
    var icon: String? = nil
    var size = FatlineStyle.avatarSize
    var dot = false
    /// False draws the letter quietly, as for a network that isn't the one showing.
    var filled = true

    @State private var loaded: CGImage?

    private var picture: CGImage? {
        loaded ?? NetworkMarkImage.cached(icon)
    }

    var body: some View {
        Group {
            if let picture {
                Image(decorative: picture, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(.rect(cornerRadius: size * FatlineStyle.markRadiusRatio, style: .continuous))
            } else {
                Text(verbatim: NetworkMarkImage.letter(name))
                    .font(.custom("Inter-SemiBold", fixedSize: size * FatlineStyle.markLetterRatio)) // The tile doesn't grow with Dynamic Type, so neither does its letter.
                    .foregroundStyle(filled ? FatlineStyle.actionInk : FatlineStyle.ink)
                    .frame(width: size, height: size)
                    .background(filled ? FatlineStyle.action : FatlineStyle.quiet,
                                in: .rect(cornerRadius: size * FatlineStyle.markRadiusRatio, style: .continuous))
            }
        }
        .unreadDot(dot, inset: -3) // layout-ok: the dot sits over the mark's corner
        .accessibilityHidden(true)
        .task(id: icon) {
            loaded = nil
            guard let url = NetworkMarkImage.iconURL(icon) else { return }
            loaded = await CastImages.load(url, maxPixels: NetworkMarkImage.iconPixels)
            // The switcher's menu draws from the cache, so it has the picture next time it opens.
        }
    }
}

extension View {
    /// The unread dot at the top trailing corner, `inset` in from it.
    func unreadDot(_ shown: Bool, inset: CGFloat) -> some View {
        overlay(alignment: .topTrailing) {
            if shown {
                Circle()
                    .fill(FatlineStyle.ink)
                    .frame(width: FatlineStyle.unreadDot, height: FatlineStyle.unreadDot)
                    .padding(FatlineStyle.unreadRing / 2)
                    .background(FatlineStyle.paper, in: .circle)
                    .padding(inset)
                    .accessibilityHidden(true)
            }
        }
    }
}

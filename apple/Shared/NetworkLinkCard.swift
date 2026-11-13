import SwiftUI

/// A link the network read, as the canvas's option A: a quiet card with the page's picture, its title,
/// two lines of description, and the site. Clicking or tapping it opens the link.
struct NetworkLinkCard: View {
    let card: NetworkModel.LinkCard
    var highlighted = false
    @State private var image: CGImage?

    private static let pictureSide: CGFloat = 56 // layout-ok: the card picture on the canvas

    var body: some View {
        Link(destination: card.url) {
            HStack(spacing: FatlineStyle.groupGap) {
                if card.image != nil {
                    ZStack {
                        Rectangle().fill(highlighted ? FatlineStyle.quiet : FatlineStyle.paper)
                        if let image {
                            Image(decorative: image, scale: 1).resizable().interpolation(.high).scaledToFill()
                        }
                    }
                    .frame(width: Self.pictureSide, height: Self.pictureSide)
                    .clipShape(.rect(cornerRadius: FatlineStyle.cardRadius, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 2) { // layout-ok: a title and its lines read as one
                    if let title = card.title {
                        Text(verbatim: title)
                            .font(FatlineStyle.bodyStrong)
                            .lineLimit(1)
                    }
                    if let description = card.description {
                        Text(verbatim: description)
                            .font(FatlineStyle.meta)
                            .foregroundStyle(FatlineStyle.secondary)
                            .lineLimit(2)
                    }
                    Text(verbatim: card.url.host() ?? card.url.absoluteString)
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(FatlineStyle.groupGap)
            .background(highlighted ? FatlineStyle.paper : FatlineStyle.quiet,
                        in: .rect(cornerRadius: FatlineStyle.cardRadius, style: .continuous))
            .foregroundStyle(FatlineStyle.ink)
            .contentShape(.rect(cornerRadius: FatlineStyle.cardRadius))
        }
        .buttonStyle(.plain)
        #if os(macOS)
        .pointerStyle(.link)
        .help(card.url.absoluteString)
        #endif
        .accessibilityLabel("\(card.title ?? card.url.host() ?? "Link"), \(card.url.host() ?? "")")
        .task(id: card.image) {
            guard let url = card.image else { return }
            image = await CastImages.load(url, maxPixels: Int(Self.pictureSide) * 2)
        }
    }
}

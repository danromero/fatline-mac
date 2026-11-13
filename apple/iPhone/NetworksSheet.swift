import SwiftUI

/// The title in a feed's bar, which opens the Networks sheet: the network's mark and name, or the
/// portal for Farcaster, with a chevron, and a dot while another network has news.
struct NetworkTitleButton: View {
    /// Nil is Farcaster.
    let membership: NetworkMembership?
    let othersHaveNews: Bool
    let action: () -> Void

    /// The portal is the Farcaster feed's own 36-point title, and a network's mark sits in the same bar.
    private static let portalSize: CGFloat = 36 // layout-ok: the Farcaster feed's title
    private static let markSize: CGFloat = 26 // layout-ok: the title's mark, as on the canvas

    var body: some View {
        Button(action: action) {
            HStack(spacing: FatlineStyle.itemGap) {
                if let membership {
                    if membership.status == .approved {
                        NetworkMark(name: membership.title, icon: membership.icon, size: Self.markSize)
                        Text(verbatim: membership.title)
                            .font(FatlineStyle.bodyStrong)
                            .lineLimit(1)
                    } else {
                        // Nothing a network says about itself shows before it lets you in.
                        NetworkWaitingMark(size: Self.markSize)
                        Text(verbatim: membership.host)
                            .font(FatlineStyle.bodyStrong)
                            .lineLimit(1)
                    }
                } else {
                    Image("Portal")
                        .resizable()
                        .frame(width: Self.portalSize, height: Self.portalSize)
                        .clipShape(.circle)
                }
                Image(systemName: "chevron.down")
                    .font(FatlineStyle.metaStrong)
                    .foregroundStyle(FatlineStyle.secondary)
                if othersHaveNews {
                    Circle()
                        .fill(FatlineStyle.ink)
                        .frame(width: FatlineStyle.unreadDot, height: FatlineStyle.unreadDot)
                }
            }
            .foregroundStyle(FatlineStyle.ink)
            .padding(.horizontal, FatlineStyle.itemGap)
            .frame(minHeight: FatlineStyle.headerHeight)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        // Like a system bar's title: it stops growing at the largest regular size, and a long press
        // shows it larger.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        .accessibilityShowsLargeContentViewer()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityHint("Shows your networks")
        .accessibilityIdentifier("network-title")
    }

    private var label: String {
        let name = membership.map { $0.status == .approved ? $0.label : $0.host } ?? "Farcaster"
        return "\(name). Switch network" + (othersHaveNews ? ", news in another network" : "")
    }
}

/// A network that hasn't let you in yet: an empty dashed tile where its mark would be.
struct NetworkWaitingMark: View {
    var size = FatlineStyle.avatarSize

    var body: some View {
        RoundedRectangle(cornerRadius: size * FatlineStyle.markRadiusRatio, style: .continuous)
            .strokeBorder(FatlineStyle.outline, style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Farcaster and each network, from the title. A check marks the one showing, a dot one with news, and
/// a network that hasn't let you in yet shows only its address, dimmed. Add Network is last.
struct NetworksSheet: View {
    /// Closes the sheet and starts joining another network.
    let addNetwork: () -> Void

    @Environment(NetworkModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var height: CGFloat = 0

    /// The sheet's rows, as on the canvas: a 32-point mark and two lines.
    private static let rowHeight: CGFloat = 60 // layout-ok: the Networks sheet's rows, as on the canvas
    /// Add Network's row, shorter than a network's, as on the canvas.
    private static let addRowHeight: CGFloat = 56 // layout-ok: the Add Network row, as on the canvas

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(spacing: 0) {
                    farcaster
                    ForEach(model.memberships) { membership in
                        divider
                        row(membership)
                    }
                    FatlineDivider(inset: FatlineStyle.gutter)
                    addRow
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .padding(.top, FatlineStyle.itemGap)
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .presentationDetents([.height(FatlineStyle.itemGap + FatlineStyle.headerHeight + max(height, Self.rowHeight))])
        .presentationDragIndicator(.visible)
        .presentationBackground(FatlineStyle.paper)
    }

    private var header: some View {
        Text("Networks")
            .font(FatlineStyle.bodyStrong)
            .accessibilityAddTraits(.isHeader)
            .frame(maxWidth: .infinity, minHeight: FatlineStyle.headerHeight)
            .overlay(alignment: .trailing) {
                Button { dismiss() } label: {
                    Text("Done")
                        .font(FatlineStyle.body)
                        .padding(.horizontal, FatlineStyle.groupGap)
                        .frame(minHeight: FatlineStyle.buttonHitHeight)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                // The label's 12-point inset puts Done's edge on the gutter.
                .padding(.trailing, FatlineStyle.gutter - FatlineStyle.groupGap)
            }
            // Like a system bar, it stops growing before the title runs into Done.
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private var divider: some View {
        FatlineDivider(inset: FatlineStyle.gutter)
            .padding(.leading, FatlineStyle.textColumn - FatlineStyle.gutter)
    }

    private var farcaster: some View {
        let showing = model.selectedHost == nil
        return Button { choose(nil) } label: {
            HStack(spacing: FatlineStyle.groupGap) {
                Image("Portal")
                    .resizable()
                    .frame(width: FatlineStyle.avatarSize, height: FatlineStyle.avatarSize)
                    .clipShape(.circle)
                    .accessibilityHidden(true)
                Text("Farcaster")
                    .font(FatlineStyle.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if showing { check }
            }
            .rowFrame(height: Self.rowHeight)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Farcaster")
        .accessibilityAddTraits(showing ? .isSelected : [])
    }

    private func row(_ membership: NetworkMembership) -> some View {
        let showing = membership.host == model.selectedHost
        let approved = membership.status == .approved
        let news = approved && model.hasNews(membership.host)
        let waiting = membership.status == .pending ? "Waiting" : "Not approved"
        return Button { choose(membership.host) } label: {
            HStack(spacing: FatlineStyle.groupGap) {
                if approved {
                    NetworkMark(name: membership.title, icon: membership.icon, filled: showing)
                } else {
                    NetworkWaitingMark()
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: approved ? membership.title : membership.host)
                        .font(news ? FatlineStyle.bodyStrong : FatlineStyle.body)
                        .lineLimit(1)
                    // The address under a network's own name, so a network can't pass for another.
                    if approved, membership.name != nil {
                        Text(verbatim: membership.host)
                            .font(FatlineStyle.meta)
                            .foregroundStyle(FatlineStyle.secondary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if showing {
                    check
                } else if news {
                    Circle()
                        .fill(FatlineStyle.ink)
                        .frame(width: FatlineStyle.unreadDot, height: FatlineStyle.unreadDot)
                } else if !approved {
                    Text(waiting).font(FatlineStyle.meta)
                }
            }
            .foregroundStyle(approved ? FatlineStyle.ink : FatlineStyle.secondary)
            .rowFrame(height: Self.rowHeight)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(approved
            ? membership.label + (news ? ", news" : "")
            : "\(membership.host), \(waiting)")
        .accessibilityAddTraits(showing ? .isSelected : [])
    }

    /// An outlined tile with a plus where a mark goes, and Add Network.
    private var addRow: some View {
        Button {
            Platform.haptic(.tap)
            addNetwork()
        } label: {
            HStack(spacing: FatlineStyle.groupGap) {
                RoundedRectangle(cornerRadius: FatlineStyle.avatarSize * FatlineStyle.markRadiusRatio, style: .continuous)
                    .strokeBorder(FatlineStyle.outline, lineWidth: 1)
                    .frame(width: FatlineStyle.avatarSize, height: FatlineStyle.avatarSize)
                    .overlay {
                        Image(systemName: "plus")
                            .font(FatlineStyle.markGlyph)
                    }
                    .accessibilityHidden(true)
                Text("Add Network")
                    .font(FatlineStyle.body)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .rowFrame(height: Self.addRowHeight)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("add-network")
    }

    private var check: some View {
        Image(systemName: "checkmark")
            .font(FatlineStyle.markGlyph)
            .foregroundStyle(FatlineStyle.ink)
            .accessibilityHidden(true)
    }

    private func choose(_ host: String?) {
        Platform.haptic(.pick)
        model.select(host)
        dismiss()
    }
}

private extension View {
    func rowFrame(height: CGFloat) -> some View {
        padding(.horizontal, FatlineStyle.gutter)
            .frame(maxWidth: .infinity, minHeight: height)
            .contentShape(.rect)
    }
}

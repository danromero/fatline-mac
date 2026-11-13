import AppKit
import SwiftUI

/// The title: a menu that switches between Farcaster and networks once setup is done. On a pushed
/// screen it says where you are instead.
struct TitleSwitcher: View {
    @Environment(AppState.self) private var state
    let showsPortal: Bool

    @State private var anchor = MenuAnchor()
    @State private var open = false

    private var networks: NetworkModel { state.networks }

    var body: some View {
        if !showsPortal {
            // Holds the title bar's height through setup, where nothing shows in it.
            Self.portal(size: FatlineStyle.avatarSize).opacity(0)
        } else if let route = state.networkPath.last, let selected = networks.selected {
            switch route {
            case .thread:
                HStack(spacing: FatlineStyle.itemGap) {
                    NetworkMark(name: selected.title, icon: selected.icon, size: Self.markSize)
                    Text(verbatim: selected.title).font(FatlineStyle.bodyStrong)
                }
                .foregroundStyle(FatlineStyle.ink)
                .accessibilityElement(children: .combine)
            case .activity:
                Text("Activity")
                    .font(FatlineStyle.bodyStrong)
                    .foregroundStyle(FatlineStyle.ink)
                    .accessibilityAddTraits(.isHeader)
            }
        } else {
            Button { showMenu() } label: { label }
                .buttonStyle(TitleButtonStyle(open: open))
                .background(MenuAnchorView(anchor: anchor))
                .accessibilityLabel("\(networks.selected?.label ?? "Farcaster"). Switch network")
                .help(networks.selected?.host ?? "Farcaster")
        }
    }

    private static let markSize: CGFloat = 22 // layout-ok: the mark is a 22-point tile in a 32-point button
    private static let portalSize: CGFloat = 24 // layout-ok: the portal's circle reads as large as the tile

    @ViewBuilder private var label: some View {
        let dot = networks.othersHaveNews
        HStack(spacing: FatlineStyle.itemGap) {
            if let selected = networks.selected {
                NetworkMark(name: selected.title, icon: selected.icon, size: Self.markSize, dot: dot)
                Text(verbatim: selected.title).font(FatlineStyle.bodyStrong)
            } else {
                Self.portal(size: Self.portalSize).unreadDot(dot, inset: 0)
            }
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .bold)) // layout-ok: a disclosure glyph, as in system menus
                .foregroundStyle(FatlineStyle.secondary)
                .accessibilityHidden(true)
        }
        .foregroundStyle(FatlineStyle.ink)
    }

    static func portal(size: CGFloat) -> some View {
        Image("Portal")
            .resizable()
            .frame(width: size, height: size)
            .clipShape(.circle)
            .accessibilityLabel("Fatline feed")
    }

    private func showMenu() {
        open = true
        anchor.popUp(menu())
        open = false
    }

    /// Farcaster, then each network with its ⌘ number, a dot for news and Waiting for a request, then Add Network.
    private func menu() -> NSMenu {
        var items: [NSMenuItem] = []
        let farcaster = ClosureMenuItem("Farcaster", key: "1") { networks.select(nil) }
        farcaster.image = NetworkMenuImage.portal()
        farcaster.state = networks.selectedHost == nil ? .on : .off
        items.append(farcaster)
        for (index, membership) in networks.memberships.enumerated() {
            let host = membership.host
            let number = index + 2
            let item = ClosureMenuItem(membership.title, key: number <= 9 ? "\(number)" : "") { networks.select(host) }
            // The host under a network's own name, so a network can't pass for another.
            if membership.name != nil { item.subtitle = host }
            switch membership.status {
            case .approved:
                item.image = NetworkMenuImage.mark(name: membership.title, icon: membership.icon, filled: host == networks.selectedHost)
                if host == networks.selectedHost {
                    item.state = .on
                } else if networks.hasNews(host) {
                    item.state = .mixed
                    item.mixedStateImage = NetworkMenuImage.dot()
                    item.attributedTitle = NSAttributedString(string: membership.title, attributes: [
                        .font: NSFont.menuFont(ofSize: 0).withWeight(.semibold),
                    ])
                }
            case .pending, .refused:
                item.image = NetworkMenuImage.waiting()
                item.state = host == networks.selectedHost ? .on : .off
                item.keyEquivalent = ""
                item.badge = NSMenuItemBadge(string: membership.status == .pending ? "Waiting" : "Not approved")
            }
            items.append(item)
        }
        items.append(.separator())
        items.append(ClosureMenuItem("Add Network…", key: "n", modifiers: [.command, .shift]) { state.addingNetwork = true })
        return .plain(items)
    }
}

/// The title as a button: no bezel, and the quiet fill a toolbar button has while its menu is open.
private struct TitleButtonStyle: ButtonStyle {
    let open: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, FatlineStyle.itemGap)
            .frame(height: FatlineStyle.outlineButtonHeight)
            .background(open || configuration.isPressed ? FatlineStyle.quiet : .clear,
                        in: .rect(cornerRadius: FatlineStyle.itemGap, style: .continuous))
            .contentShape(.rect)
    }
}

/// Activity, on the title bar's trailing side: a tray, with a dot while there's something new.
struct ActivityButton: View {
    @Environment(AppState.self) private var state

    var body: some View {
        let new = state.networks.hasNewActivity
        Button { state.networkPath.append(.activity) } label: {
            Image(systemName: "tray")
                .font(.system(size: 15)) // layout-ok: a bar glyph, sized to the 17-point tray on the canvas
                .foregroundStyle(FatlineStyle.secondary)
                .frame(width: FatlineStyle.avatarSize, height: FatlineStyle.avatarSize)
                .unreadDot(new, inset: 3) // layout-ok: puts the dot on the tray's corner
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Activity")
        .accessibilityLabel(new ? "Activity, new replies" : "Activity")
    }
}

/// Pictures for the network menu, drawn when the menu shows so they follow light and dark.
enum NetworkMenuImage {
    private static let size: CGFloat = 18 // layout-ok: an icon in a 13-point menu row

    /// The picture once a mark on screen has loaded it, otherwise the letter.
    @MainActor static func mark(name: String, icon: String?, filled: Bool) -> NSImage {
        if let picture = NetworkMarkImage.cached(icon) {
            return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
                NSBezierPath(roundedRect: rect, xRadius: size * FatlineStyle.markRadiusRatio, yRadius: size * FatlineStyle.markRadiusRatio).addClip()
                NSImage(cgImage: picture, size: rect.size).draw(in: rect)
                return true
            }
        }
        return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let path = NSBezierPath(roundedRect: rect, xRadius: size * FatlineStyle.markRadiusRatio, yRadius: size * FatlineStyle.markRadiusRatio)
            NSColor(filled ? FatlineStyle.action : FatlineStyle.quiet).setFill()
            path.fill()
            let font = NSFont(name: "Inter-SemiBold", size: size * FatlineStyle.markLetterRatio) ?? .systemFont(ofSize: size * FatlineStyle.markLetterRatio, weight: .semibold)
            let text = NSAttributedString(string: NetworkMarkImage.letter(name), attributes: [
                .font: font,
                .foregroundColor: NSColor(filled ? FatlineStyle.actionInk : FatlineStyle.ink),
            ])
            let bounds = text.size()
            text.draw(at: NSPoint(x: rect.midX - bounds.width / 2, y: rect.midY - bounds.height / 2))
            return true
        }
    }

    static func waiting() -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let path = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: size * FatlineStyle.markRadiusRatio, yRadius: size * FatlineStyle.markRadiusRatio)
            path.lineWidth = 1
            path.setLineDash([3, 2], count: 2, phase: 0)
            NSColor(FatlineStyle.outline).setStroke()
            path.stroke()
            return true
        }
    }

    static func portal() -> NSImage {
        NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            NSBezierPath(ovalIn: rect).addClip()
            NSImage(named: "Portal")?.draw(in: rect)
            return true
        }
    }

    static func dot() -> NSImage {
        let side: CGFloat = 6 // layout-ok: the dot in a menu's check column
        return NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSColor(FatlineStyle.ink).setFill()
            NSBezierPath(ovalIn: rect).fill()
            return true
        }
    }
}

private extension NSFont {
    func withWeight(_ weight: NSFont.Weight) -> NSFont {
        .systemFont(ofSize: pointSize, weight: weight)
    }
}

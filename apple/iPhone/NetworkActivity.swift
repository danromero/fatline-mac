import SwiftUI

/// The tray at the leading edge of a network's bar, with a dot while Activity has something new.
struct NetworkActivityButton: View {
    let action: () -> Void

    @Environment(NetworkModel.self) private var model

    var body: some View {
        let new = model.hasNewActivity
        Button(action: action) {
            Image(systemName: "tray")
                .font(FatlineStyle.markGlyph)
                .foregroundStyle(FatlineStyle.secondary)
                .unreadDot(new, inset: -3) // layout-ok: the dot sits over the tray's corner, as on a mark
                .frame(width: FatlineStyle.buttonHitHeight, height: FatlineStyle.buttonHitHeight)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(new ? "Activity, new replies" : "Activity")
        .accessibilityIdentifier("network-activity")
    }
}

/// Replies to your posts and mentions of you, pushed from the feed. Each row opens the replies it's
/// part of, and a reply quotes the post it answers.
struct NetworkActivityView: View {
    let open: (NetworkPost) -> Void

    @Environment(NetworkModel.self) private var model
    @State private var items: [NetworkActivity.Item] = []
    @State private var loaded = false
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 0) {
            FatlineDivider()
            ScrollView {
                LazyVStack(spacing: 0) {
                    if let failure {
                        FeedMessage(text: failure, color: FatlineStyle.danger)
                    } else if loaded && items.isEmpty {
                        FeedMessage(text: "Replies to your posts and mentions of you show here.")
                    }
                    ForEach(items, id: \.post.hash) { item in
                        Button { open(item.threadRoot) } label: {
                            CastRow(cast: cast(for: item), handle: model.handle(for: item.post.fid),
                                    action: item.kind == "reply" ? "replied" : "mentioned you")
                                .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens the replies")
                        if item.post.hash != items.last?.post.hash { CastDivider() }
                    }
                }
            }
            .refreshable { await load() }
        }
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .fatlineTitle("Activity")
        .task { await load() }
    }

    /// The post, quoting the one it answers.
    private func cast(for item: NetworkActivity.Item) -> FeedCast {
        var cast = model.cast(for: item.post)
        if let parent = item.parent, !parent.deleted {
            cast.quote = FeedCast.Quote(fid: parent.fid, handle: model.handle(for: parent.fid), text: parent.text)
        }
        return cast
    }

    /// Reading Activity marks it seen, which clears the tray's dot.
    private func load() async {
        do {
            items = try await model.activity()
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
        loaded = true
    }
}

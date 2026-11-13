import AppKit
import SwiftUI

// Fatline networks on the Mac: a network's feed, a post's replies and Activity, pushed in the window.
// Farcaster's own feed is unchanged and shows when no network is selected.

/// Where the network window has gone from its feed.
enum NetworkRoute: Hashable {
    case thread(NetworkPost)
    case activity
}

/// A network's feed, or where it stands while the admin decides.
struct NetworkWindow: View {
    let membership: NetworkMembership
    @Environment(AppState.self) private var state

    private var model: NetworkModel { state.networks }

    var body: some View {
        NavigationStack(path: Bindable(state).networkPath) {
            root
                .navigationDestination(for: NetworkRoute.self) { route in
                    Group {
                        switch route {
                        case .thread(let post): NetworkThreadView(post: post)
                        case .activity: NetworkActivityView()
                        }
                    }
                    .networkScreen()
                }
        }
        .overlay(alignment: .top) { NetworkToast().padding(.top, FatlineStyle.castGap) }
        .toolbar {
            if membership.status == .approved && state.networkPath.isEmpty {
                ToolbarItem(placement: .primaryAction) { ActivityButton() }
                    .sharedBackgroundVisibility(.hidden)
            }
        }
        .task(id: membership.host + membership.status.rawValue) {
            // Reads now, then each minute while this network shows.
            while !Task.isCancelled {
                await model.refresh()
                try? await Task.sleep(for: .seconds(NetworkModel.pollInterval))
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            if model.isStale { Task { await model.refresh() } }
        }
    }

    @ViewBuilder private var root: some View {
        switch membership.status {
        case .approved:
            feed.networkScreen()
        case .pending:
            NetworkStatusView(status: .pending, host: membership.host, button: "Check Again") {
                Task { await model.checkAgain(membership.host) }
            }
            .networkScreen()
        case .refused:
            NetworkStatusView(status: .refused, host: membership.host, button: "Remove from This Mac") {
                model.forget(membership.host)
            }
            .networkScreen()
        }
    }

    private var feed: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if let problem = model.problem {
                    FeedMessage(text: problem, color: FatlineStyle.danger)
                    CastDivider()
                }
                ForEach(model.posts) { post in
                    NetworkPostRow(post: post) { state.networkPath.append(.thread(post)) }
                    if post.id != model.posts.last?.id { CastDivider() }
                }
            }
            .frame(maxWidth: FatlineStyle.columnMaxWidth)
            .padding(.bottom, 76) // layout-ok: room to scroll the last post clear of the floating plus, as in the feed
            .frame(maxWidth: .infinity)
        }
        .overlay {
            if model.posts.isEmpty && model.lastRead != nil {
                Text("No posts yet")
                    .font(FatlineStyle.body)
                    .foregroundStyle(FatlineStyle.secondary)
            }
        }
        .overlay(alignment: .bottom) {
            Button { state.newPost() } label: {
                Image(systemName: "plus")
                    .font(FatlineStyle.plusGlyph)
                    .foregroundStyle(FatlineStyle.actionInk)
                    .frame(width: 48, height: 48) // layout-ok: the plus is the same 48 as the feed's
                    .background(FatlineStyle.action, in: .circle)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Compose")
            .padding(.trailing, FatlineStyle.gutter)
            .padding(.bottom, FatlineStyle.gutter)
            .frame(maxWidth: FatlineStyle.columnMaxWidth, alignment: .trailing)
        }
    }
}

private extension View {
    /// Each screen in the network window: a full rule under the title bar, on paper.
    func networkScreen() -> some View {
        VStack(spacing: 0) {
            FatlineDivider()
            self.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(FatlineStyle.paper)
        .foregroundStyle(FatlineStyle.ink)
        .tint(FatlineStyle.action)
        .navigationTitle("")
        .toolbarBackground(FatlineStyle.paper, for: .windowToolbar)
        .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
    }
}

/// A post with reply and like under it. Right-clicking opens its menu and keeps the row highlighted.
struct NetworkPostRow: View {
    enum Place { case feed, root, reply }

    let post: NetworkPost
    var place = Place.feed
    /// What Reply does: open the replies from the feed, or go to the reply field beside them.
    let reply: () -> Void

    @Environment(AppState.self) private var state
    @State private var menuOpen = false
    @State private var confirmingDelete = false
    @State private var reporting = false
    @State private var reportNote = ""

    private var model: NetworkModel { state.networks }
    private var handle: String { model.handle(for: post.fid) }
    private var isOwn: Bool { post.fid == model.ownFID }

    var body: some View {
        if post.deleted {
            FeedMessage(text: "This post was deleted")
        } else {
            VStack(alignment: .leading, spacing: 0) {
                CastRow(cast: model.cast(for: post), handle: handle, bottomInset: 0, highlighted: menuOpen)
                ForEach(model.linkCards(for: post)) { card in
                    NetworkLinkCard(card: card, highlighted: menuOpen)
                        .padding(.leading, FatlineStyle.textColumn)
                        .padding(.trailing, FatlineStyle.gutter)
                        .padding(.top, FatlineStyle.castGap)
                }
                actions
            }
            .background(menuOpen ? FatlineStyle.quiet : FatlineStyle.paper)
            .rightClickMenu(open: $menuOpen, menu)
            .accessibilityActions {
                Button("Reply", action: reply)
                Button("Copy Text") { Platform.copyToClipboard(post.text) }
                if isOwn {
                    Button("Delete…") { confirmingDelete = true }
                } else {
                    Button("Mute \(handle)") { mute() }
                    Button("Report…") { reporting = true }
                }
            }
            .alert("Delete this post?", isPresented: $confirmingDelete) {
                Button("Cancel", role: .cancel) {}
                    .keyboardShortcut(.defaultAction)
                Button("Delete", role: .destructive) {
                    Task {
                        do { try await model.delete(post) } catch { model.toast = error.localizedDescription }
                    }
                }
            } message: {
                Text(post.replies > 0 ? "Its replies stay, under “This post was deleted.”" : "It’s removed for everyone in this network.")
            }
            .alert("Report this post?", isPresented: $reporting) {
                TextField("Note", text: $reportNote, prompt: Text("Optional note"))
                Button("Cancel", role: .cancel) {}
                Button("Report") { report() }
            } message: {
                Text("The admin of \(model.selected?.title ?? "this network") will see it.")
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 0) {
            if place != .reply {
                actionSlot(symbol: "bubble.left", count: post.replies, color: FatlineStyle.secondary, action: reply)
                    .accessibilityLabel(post.replies == 1 ? "1 reply" : "\(post.replies) replies")
            }
            actionSlot(symbol: post.liked ? "heart.fill" : "heart", count: post.likes,
                       color: post.liked ? FatlineStyle.action : FatlineStyle.secondary) {
                Task { await model.toggleLike(post) }
            }
            .accessibilityLabel(post.liked ? "Unlike" : "Like")
            .accessibilityValue(post.likes == 1 ? "1 like" : "\(post.likes) likes")
        }
        .buttonStyle(.plain)
        .font(FatlineStyle.meta)
        .foregroundStyle(FatlineStyle.secondary)
        .padding(.leading, FatlineStyle.textColumn)
        .padding(.top, FatlineStyle.castGap)
        .padding(.bottom, FatlineStyle.actionsBottom)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Wide enough for the icon and a three-digit count, so nothing after it moves when a count appears.
    /// Counts are hidden at zero.
    private func actionSlot(symbol: String, count: Int, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: FatlineStyle.actionIconGap) {
                Image(systemName: symbol)
                    .font(FatlineStyle.body)
                    .foregroundStyle(color)
                if count > 0 { Text("\(count)").monospacedDigit() }
            }
            .frame(width: FatlineStyle.actionSlotWidth, height: FatlineStyle.actionSlotHeight, alignment: .leading)
            .contentShape(.rect)
        }
    }

    /// Reply, Copy Text, Copy Link, then Delete for your own posts, or Mute and Report for others'.
    private func menu() -> NSMenu {
        var items: [NSMenuItem] = [
            ClosureMenuItem("Reply", handler: reply),
            ClosureMenuItem("Copy Text") { Platform.copyToClipboard(post.text) },
        ]
        if let link = model.link(for: post) {
            items.append(ClosureMenuItem("Copy Link") { Platform.copyToClipboard(link.absoluteString) })
        }
        items.append(.separator())
        if isOwn {
            items.append(ClosureMenuItem("Delete…") { confirmingDelete = true })
        } else {
            items.append(ClosureMenuItem("Mute \(handle)") { mute() })
            items.append(ClosureMenuItem("Report…") {
                reportNote = ""
                reporting = true
            })
        }
        return .plain(items)
    }

    private func mute() {
        Task {
            do { try await model.setMuted(post.fid, true) } catch { model.toast = error.localizedDescription }
        }
    }

    private func report() {
        let note = String(reportNote.trimmingCharacters(in: .whitespacesAndNewlines).prefix(NetworkMessages.maxCharacters))
        Task {
            do { try await model.report(post, note: note) } catch { model.toast = error.localizedDescription }
        }
    }
}

/// A post and its replies, pushed in the window, with a bar at the bottom to reply.
struct NetworkThreadView: View {
    let post: NetworkPost
    @Environment(AppState.self) private var state
    @State private var root: NetworkPost?
    @State private var replies: [NetworkPost] = []
    @State private var loaded = false
    @State private var reply = ""
    @State private var sending = false
    @State private var failure: String?
    /// The network this thread is on, which a reply goes to whatever is showing later.
    @State private var host: String?
    @FocusState private var replyFocused: Bool

    private var shown: NetworkPost { root ?? post }
    private var canSend: Bool {
        !sending && !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && NetworkMessages.characterCount(reply) <= NetworkMessages.maxCharacters
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        NetworkPostRow(post: shown, place: .root) { replyFocused = true }
                        CastDivider()
                        if let failure {
                            FeedMessage(text: failure, color: FatlineStyle.danger)
                        } else if loaded && replies.isEmpty {
                            FeedMessage(text: "No replies yet")
                        }
                        ForEach(replies) { item in
                            NetworkPostRow(post: item, place: .reply) { replyFocused = true }
                                .id(item.id)
                            if item.id != replies.last?.id { CastDivider() }
                        }
                    }
                    .frame(maxWidth: FatlineStyle.columnMaxWidth)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: replies.last?.id) { _, last in
                    if let last { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
                }
            }
            if !shown.deleted { replyBar }
        }
        .task {
            if host == nil { host = state.networks.selectedHost }
            await load()
        }
        .onChange(of: state.networks.posts) { Task { await load() } }
    }

    private var replyBar: some View {
        VStack(spacing: 0) {
            FatlineDivider()
            HStack(alignment: .bottom, spacing: FatlineStyle.itemGap) {
                TextField("Reply", text: $reply, prompt: Text("Write a reply…").foregroundStyle(FatlineStyle.secondary), axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(FatlineStyle.body)
                    .lineLimit(1...4)
                    .focused($replyFocused)
                    .onSubmit(send)
                    .padding(.horizontal, FatlineStyle.groupGap)
                    .padding(.vertical, FatlineStyle.castGap + 1) // layout-ok: centers a 20-point line in 30
                    .frame(minHeight: FatlineStyle.compactButtonHeight)
                    .background(FatlineStyle.quiet, in: .rect(cornerRadius: FatlineStyle.compactButtonHeight / 2, style: .continuous))
                Button(sending ? "Posting…" : "Post", action: send)
                    .buttonStyle(FatlinePrimaryButton(compact: true, minWidth: 68, isWorking: sending)) // layout-ok: the composer's Post width
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSend)
            }
            .padding(.horizontal, FatlineStyle.gutter)
            .padding(.vertical, FatlineStyle.barPadding)
            .frame(maxWidth: FatlineStyle.columnMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .background(FatlineStyle.paper)
    }

    private func load() async {
        do {
            let thread = try await state.networks.thread(post.hash)
            root = thread.post
            replies = thread.replies
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
        loaded = true
    }

    private func send() {
        guard canSend, let host else { return }
        sending = true
        failure = nil
        Task {
            do {
                try await state.networks.post(to: host, text: reply, parent: shown)
                reply = ""
                await load()
            } catch {
                failure = error.localizedDescription
            }
            sending = false
        }
    }
}

/// Replies to your posts and mentions of you, pushed in the window. Each opens the replies it's part of.
struct NetworkActivityView: View {
    @Environment(AppState.self) private var state
    @State private var items: [NetworkActivity.Item] = []
    @State private var loaded = false
    @State private var failure: String?

    private var model: NetworkModel { state.networks }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if let failure {
                    FeedMessage(text: failure, color: FatlineStyle.danger)
                } else if loaded && items.isEmpty {
                    FeedMessage(text: "Replies to your posts and mentions of you show here.")
                }
                ForEach(items, id: \.post.hash) { item in
                    Button { state.networkPath.append(.thread(item.threadRoot)) } label: {
                        CastRow(cast: cast(for: item), handle: model.handle(for: item.post.fid),
                                action: item.kind == "reply" ? "replied" : "mentioned you")
                    }
                    .buttonStyle(.plain)
                    if item.post.hash != items.last?.post.hash { CastDivider() }
                }
            }
            .frame(maxWidth: FatlineStyle.columnMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .task {
            do { items = try await model.activity() } catch { failure = error.localizedDescription }
            loaded = true
        }
    }

    /// The post, quoting the one it answers.
    private func cast(for item: NetworkActivity.Item) -> FeedCast {
        var cast = model.cast(for: item.post)
        if let parent = item.parent, !parent.deleted {
            cast.quote = FeedCast.Quote(fid: parent.fid, handle: model.handle(for: parent.fid), text: parent.text)
        }
        return cast
    }
}

private struct NetworkToast: View {
    @Environment(AppState.self) private var state

    var body: some View {
        if let toast = state.networks.toast {
            HStack(spacing: 6) { // layout-ok: the feed's confirmation pill
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(FatlineStyle.action)
                    .accessibilityHidden(true)
                Text(toast)
            }
            .font(FatlineStyle.bodyStrong)
            .padding(.horizontal, FatlineStyle.groupGap)
            .frame(height: FatlineStyle.compactButtonHeight)
            .background(FatlineStyle.quiet, in: .capsule)
            .overlay { Capsule().strokeBorder(FatlineStyle.line) }
            .transition(.opacity)
            .allowsHitTesting(false)
            .task(id: toast) {
                try? await Task.sleep(for: .seconds(3))
                if state.networks.toast == toast { state.networks.toast = nil }
            }
        }
    }
}

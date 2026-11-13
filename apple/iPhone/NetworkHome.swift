import SwiftUI
import UIKit

// A Fatline network on iPhone: its feed under a bar whose title switches networks. Farcaster's own
// feed is unchanged and shows when no network is selected.

/// Where a network's screen has gone from its feed.
enum NetworkRoute: Hashable {
    case thread(NetworkPost)
    case activity
}

/// A network's feed, or where it stands while the admin decides.
struct NetworkHome: View {
    let membership: NetworkMembership
    /// Opens the Networks sheet.
    let switchNetwork: () -> Void

    @Environment(NetworkModel.self) private var model
    @State private var path: [NetworkRoute] = []
    @State private var composing = false
    @State private var showSettings = false

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                bar
                FatlineDivider()
                switch membership.status {
                case .approved:
                    feed
                case .pending:
                    NetworkStatusView(status: .pending, host: membership.host, button: "Check Again") {
                        Platform.haptic(.tap)
                        Task { await model.checkAgain(membership.host) }
                    }
                case .refused:
                    NetworkStatusView(status: .refused, host: membership.host, button: "Remove from This iPhone") {
                        model.forget(membership.host)
                    }
                }
            }
            .background(FatlineStyle.paper.ignoresSafeArea())
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: NetworkRoute.self) { route in
                switch route {
                case .thread(let post): NetworkThreadView(post: post)
                case .activity: NetworkActivityView { path.append(.thread($0)) }
                }
            }
        }
        .foregroundStyle(FatlineStyle.ink)
        .tint(FatlineStyle.action)
        // This view lasts as long as its network shows, so the composer posts to the one it opened on.
        .sheet(isPresented: $showSettings) {
            NetworkSettingsSheet(membership: membership)
        }
        .sheet(isPresented: $composing) {
            NetworkComposer(host: membership.host)
                .tint(FatlineStyle.action)
        }
    }

    /// The title in the middle, as in the Farcaster feed's header, with Activity at the leading edge once
    /// the network has let you in.
    private var bar: some View {
        NetworkTitleButton(membership: membership, othersHaveNews: model.othersHaveNews, action: switchNetwork)
            .frame(maxWidth: .infinity, minHeight: FatlineStyle.headerHeight)
            .overlay(alignment: .leading) {
                if membership.status == .approved {
                    // The 20-point tray is centered in its 44-point target, which puts its edge on the gutter.
                    NetworkActivityButton { path.append(.activity) }
                        .padding(.leading, FatlineStyle.gutter - FatlineStyle.groupGap)
                }
            }
            .overlay(alignment: .trailing) {
                Button { showSettings = true } label: {
                    Image(systemName: "ellipsis")
                        .font(FatlineStyle.markGlyph)
                        .foregroundStyle(FatlineStyle.secondary)
                        .frame(width: FatlineStyle.buttonHitHeight, height: FatlineStyle.buttonHitHeight)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Settings")
                .accessibilityIdentifier("network-settings")
                // As in the Farcaster feed: the 15-point glyph is centered in its 44-point target, which puts
                // its edge on the gutter.
                .padding(.trailing, 1.5) // layout-ok: matches the Farcaster feed's three dots
            }
            .padding(.bottom, FatlineStyle.headerGap)
    }

    private var feed: some View {
        VStack(spacing: 0) {
            if let problem = model.problem, !model.posts.isEmpty {
                FeedProblemBanner(message: problem, lastRead: model.lastRead, checking: model.loading) {
                    Platform.haptic(.tap)
                    Task { await model.refresh() }
                }
                FatlineDivider()
            }
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(model.posts) { post in
                        NetworkPostRow(post: post) { path.append(.thread(post)) }
                        if post.id != model.posts.last?.id { CastDivider() }
                    }
                }
                .padding(.bottom, FatlineStyle.plusClearance)
            }
            .overlay {
                if model.posts.isEmpty {
                    Text(emptyMessage)
                        .font(FatlineStyle.body)
                        .foregroundStyle(FatlineStyle.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, FatlineStyle.gutter)
                        .allowsHitTesting(false)
                }
            }
            .refreshable { await model.refresh() }
            .overlay(alignment: .bottom) {
                NetworkToastHost().padding(.bottom, FatlineStyle.plusClearance)
            }
            .overlay(alignment: .bottomTrailing) { ComposeButton { composing = true } }
        }
    }

    private var emptyMessage: String {
        if model.problem != nil { return "Couldn’t load this network. Pull down to try again." }
        if model.lastRead == nil { return "Loading…" }
        return "No posts yet"
    }
}

/// The network's confirmations, such as Sent, in the Farcaster feed's toast. Each clears after four
/// seconds, as there.
struct NetworkToastHost: View {
    @Environment(NetworkModel.self) private var model

    var body: some View {
        ZStack {
            if let toast = model.toast {
                FeedToastView(toast: PostToast(detail: nil, confirmation: toast))
                    .padding(.horizontal, FatlineStyle.gutter)
                    .allowsHitTesting(false)
                    .transition(.opacity)
                    .task(id: toast) {
                        Platform.announce(toast)
                        do { try await Task.sleep(for: .seconds(4)) } catch { return }
                        if model.toast == toast { model.toast = nil }
                    }
            }
        }
        .animation(Platform.reduceMotion ? nil : .easeInOut(duration: 0.2), value: model.toast)
    }
}

/// A post with Reply and Like under it, each in a fixed 64-point slot so the heart stays put. Holding
/// it opens the system menu in the Mac's order: Reply, Copy Text, Copy Link, then Mute and Report for
/// someone else's post, or Delete for your own.
struct NetworkPostRow: View {
    enum Place { case feed, root, reply }

    let post: NetworkPost
    var place = Place.feed
    /// Opens the post's replies, from the feed.
    var open: (() -> Void)? = nil
    /// What Reply does in a thread: goes to the reply field. From the feed, Reply opens the replies.
    var reply: (() -> Void)? = nil
    /// After a like goes through, for a list that holds its own copy of the post.
    var liked: () async -> Void = {}

    @Environment(NetworkModel.self) private var model
    /// The like as tapped, shown until the network's answer replaces it.
    @State private var pending: (liked: Bool, likes: Int)?
    @State private var confirmingDelete = false
    @State private var deleting = false
    @State private var reporting = false
    @State private var reportNote = ""
    @State private var problem: Problem?

    private struct Problem: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    private var isLiked: Bool { pending?.liked ?? post.liked }
    private var likes: Int { pending?.likes ?? post.likes }
    private var handle: String { model.handle(for: post.fid) }
    private var isOwn: Bool { post.fid == model.ownFID }
    private var replyAction: (() -> Void)? { reply ?? open }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CastRow(cast: model.cast(for: post), handle: model.handle(for: post.fid), bottomInset: 0)
            ForEach(model.linkCards(for: post)) { card in
                NetworkLinkCard(card: card)
                    .padding(.leading, FatlineStyle.textColumn)
                    .padding(.trailing, FatlineStyle.gutter)
                    .padding(.top, FatlineStyle.castGap)
            }
            actions
        }
        .background(FatlineStyle.paper)
        .opacity(deleting ? 0.4 : 1)
        .contentShape(.rect)
        .onTapGesture { open?() }
        .contextMenu { menu }
        .accessibilityActions {
            if let open { Button("Open Replies", action: open) }
            if let replyAction, reply != nil { Button("Reply", action: replyAction) }
            if !post.text.isEmpty { Button("Copy Text", action: copyText) }
            if isOwn {
                Button("Delete…") { confirmingDelete = true }
            } else {
                Button("Mute \(handle)", action: mute)
                Button("Report…", action: startReport)
            }
        }
        .confirmationDialog("Delete this post?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive, action: delete)
        } message: {
            Text(post.replies > 0 ? "Its replies stay, under “This post was deleted.”" : "It’s removed for everyone in this network.")
        }
        .alert("Report this post?", isPresented: $reporting) {
            TextField("Note", text: $reportNote, prompt: Text("Optional note"))
            Button("Cancel", role: .cancel) {}
            Button("Report", action: report)
        } message: {
            Text("The admin of \(model.selected?.title ?? "this network") will see it.")
        }
        .alert(problem?.title ?? "", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } }), presenting: problem) { _ in
            Button("OK", role: .cancel) {}
        } message: { problem in
            Text(problem.message)
        }
    }

    @ViewBuilder private var menu: some View {
        if let replyAction {
            Button("Reply", systemImage: "arrowshape.turn.up.left", action: replyAction)
        }
        if !post.text.isEmpty {
            Button("Copy Text", systemImage: "doc.on.doc", action: copyText)
        }
        if let link = model.link(for: post) {
            Button("Copy Link", systemImage: "link") {
                UIPasteboard.general.string = link.absoluteString
                Platform.haptic(.tap)
            }
        }
        Divider()
        if isOwn {
            if !deleting {
                Button("Delete…", systemImage: "trash", role: .destructive) { confirmingDelete = true }
            }
        } else {
            Button("Mute \(handle)", systemImage: "speaker.slash", action: mute)
            Button("Report…", systemImage: "exclamationmark.bubble", action: startReport)
        }
    }

    private func copyText() {
        UIPasteboard.general.string = post.text
        Platform.haptic(.tap)
    }

    private func delete() {
        deleting = true
        Task {
            do {
                try await model.delete(post)
            } catch {
                Platform.haptic(.problem)
                problem = Problem(title: "Couldn’t delete the post", message: error.localizedDescription)
            }
            deleting = false
        }
    }

    private func mute() {
        Task {
            do {
                try await model.setMuted(post.fid, true)
            } catch {
                Platform.haptic(.problem)
                problem = Problem(title: "Couldn’t mute \(handle)", message: error.localizedDescription)
            }
        }
    }

    private func startReport() {
        reportNote = ""
        reporting = true
    }

    private func report() {
        let note = String(reportNote.trimmingCharacters(in: .whitespacesAndNewlines).prefix(NetworkMessages.maxCharacters))
        Task {
            do {
                try await model.report(post, note: note)
            } catch {
                Platform.haptic(.problem)
                problem = Problem(title: "Couldn’t report the post", message: error.localizedDescription)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 0) {
            if place != .reply {
                slot(symbol: "bubble.left", count: post.replies, color: FatlineStyle.secondary) { (reply ?? open)?() }
                    .accessibilityLabel("Reply")
                    .accessibilityValue(post.replies == 1 ? "1 reply" : "\(post.replies) replies")
            }
            slot(symbol: isLiked ? "heart.fill" : "heart", count: likes,
                 color: isLiked ? FatlineStyle.action : FatlineStyle.secondary, action: like)
                .accessibilityLabel(isLiked ? "Unlike" : "Like")
                .accessibilityValue(likes == 1 ? "1 like" : "\(likes) likes")
        }
        .font(FatlineStyle.meta)
        .foregroundStyle(FatlineStyle.secondary)
        // Each slot insets its icon by 12, so the icons start on the text column.
        .padding(.leading, FatlineStyle.textColumn - FatlineStyle.groupGap)
        .padding(.vertical, FatlineStyle.castGap)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A 44-point target that takes 36 points of the row, so the icons sit 14 from the text above and
    /// the rule below, like the row's own padding. Counts are hidden at zero. The slot grows past 64 by
    /// 44 only for the largest text sizes, where its icon and count don't fit.
    private func slot(symbol: String, count: Int, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: FatlineStyle.actionIconGap) {
                Image(systemName: symbol)
                    .font(FatlineStyle.body)
                    .foregroundStyle(color)
                if count > 0 { Text("\(count)").monospacedDigit() }
            }
            .padding(.leading, FatlineStyle.groupGap)
            .frame(minWidth: FatlineStyle.actionSlotWidth, minHeight: FatlineStyle.buttonHitHeight, alignment: .leading)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.vertical, -FatlineStyle.castGap)
    }

    private func like() {
        Platform.haptic(.pick)
        let now = !isLiked
        pending = (now, max(0, likes + (now ? 1 : -1)))
        Task {
            await model.toggleLike(post)
            await liked()
            pending = nil
        }
    }
}

/// A post and its replies, pushed from the feed, each with Like, and a bar at the bottom to reply. A
/// post deleted since it was opened shows a placeholder, and its replies stay under it with no bar.
struct NetworkThreadView: View {
    let post: NetworkPost

    @Environment(NetworkModel.self) private var model
    @State private var root: NetworkPost?
    @State private var replies: [NetworkPost] = []
    @State private var loaded = false
    @State private var failure: String?
    @State private var reply = ""
    @State private var sending = false
    @State private var sendFailure: String?
    /// The network this thread is on, which a reply goes to whatever is showing later.
    @State private var host: String?
    @FocusState private var replyFocused: Bool

    private var shown: NetworkPost { root ?? post }
    private var canSend: Bool {
        !sending && host != nil && !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && NetworkMessages.characterCount(reply) <= NetworkMessages.maxCharacters
    }

    var body: some View {
        VStack(spacing: 0) {
            FatlineDivider()
            ScrollViewReader { scroller in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if shown.deleted {
                            NetworkDeletedRow()
                        } else {
                            NetworkPostRow(post: shown, place: .root, reply: { replyFocused = true }, liked: load)
                        }
                        FatlineDivider()
                        if let failure {
                            FeedMessage(text: failure, color: FatlineStyle.danger)
                        } else if loaded && replies.isEmpty {
                            FeedMessage(text: "No replies yet")
                        }
                        ForEach(replies) { item in
                            NetworkPostRow(post: item, place: .reply, reply: { replyFocused = true }, liked: load)
                                .id(item.id)
                            if item.id != replies.last?.id { CastDivider() }
                        }
                    }
                }
                .scrollDismissesKeyboard(.interactively)
                .refreshable { await load() }
                .overlay(alignment: .bottom) {
                    NetworkToastHost().padding(.bottom, FatlineStyle.groupGap)
                }
                .onChange(of: replies.last?.id) { _, last in
                    guard let last else { return }
                    withAnimation(Platform.reduceMotion ? nil : .default) { scroller.scrollTo(last, anchor: .bottom) }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !shown.deleted { replyBar }
        }
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .fatlineTitle(model.selected?.title ?? "")
        .task {
            if host == nil { host = model.selectedHost }
            await load()
        }
        // The feed reads each minute, and its posts changing means this thread may have too.
        .onChange(of: model.posts) { Task { await load() } }
    }

    /// A round field and a Post pill on the gutter, riding the keyboard. It stops growing where the pill
    /// would crowd out the field, as the composer's header does.
    private var replyBar: some View {
        NetworkReplyBar(text: $reply, focused: $replyFocused, sending: sending, canSend: canSend, failure: sendFailure, send: send)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    }

    private func send() {
        guard canSend, let host else { return }
        Platform.haptic(.tap)
        sending = true
        sendFailure = nil
        Task {
            do {
                try await model.post(to: host, text: reply, parent: shown)
                Platform.haptic(.done)
                reply = ""
                await load()
            } catch {
                Platform.haptic(.problem)
                sendFailure = error.localizedDescription
            }
            sending = false
        }
    }

    private func load() async {
        do {
            let thread = try await model.thread(post.hash)
            root = thread.post
            replies = thread.replies
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
        loaded = true
    }
}

/// The bar under a thread. The pill stays on the last line as the field grows.
private struct NetworkReplyBar: View {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let sending: Bool
    let canSend: Bool
    let failure: String?
    let send: () -> Void

    /// The field grows with the text size as the Post pill beside it does, so the two stay one height.
    @ScaledMetric(relativeTo: .subheadline) private var fieldHeight = FatlineStyle.regularButtonHeight

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            FatlineDivider()
            if let failure {
                Text(failure)
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, FatlineStyle.gutter)
                    .padding(.top, FatlineStyle.itemGap)
            }
            HStack(alignment: .bottom, spacing: FatlineStyle.itemGap) {
                TextField("Reply", text: $text, prompt: Text("Write a reply…").foregroundStyle(FatlineStyle.secondary), axis: .vertical)
                    .font(FatlineStyle.body)
                    .lineLimit(1...5)
                    .focused(focused)
                    .accessibilityIdentifier("network-reply-text")
                    .padding(.horizontal, FatlineStyle.fieldInset)
                    .padding(.vertical, FatlineStyle.itemGap)
                    .frame(minHeight: fieldHeight)
                    .background(FatlineStyle.quiet, in: .rect(cornerRadius: fieldHeight / 2, style: .continuous))
                Button(sending ? "Posting…" : "Post", action: send)
                    .buttonStyle(FatlinePrimaryButton(minWidth: FatlineStyle.postPillWidth, isWorking: sending))
                    .disabled(!canSend)
                    .accessibilityIdentifier("network-reply-post")
            }
            .padding(.horizontal, FatlineStyle.gutter)
            .padding(.vertical, FatlineStyle.barPadding)
        }
        .background(FatlineStyle.paper.ignoresSafeArea(edges: .bottom))
    }
}

/// Where a deleted post was: an empty dashed circle where the avatar goes, and one line.
private struct NetworkDeletedRow: View {
    var body: some View {
        HStack(spacing: FatlineStyle.avatarGap) {
            Circle()
                .strokeBorder(FatlineStyle.outline, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                .frame(width: FatlineStyle.avatarSize, height: FatlineStyle.avatarSize)
                .accessibilityHidden(true)
            Text("This post was deleted")
                .font(FatlineStyle.body)
                .foregroundStyle(FatlineStyle.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, FatlineStyle.gutter)
        .padding(.vertical, FatlineStyle.rowPadding)
    }
}

import SwiftUI
import UIKit

struct FeedHome: View {
    let username: String?
    /// True right after signing in, which is when the follow list is read from the network.
    let signedIn: Bool
    /// Why Sign Out is unavailable right now, or nil when it's available.
    let signOutBlock: String?
    let notice: String?
    let latestPost: FeedCast?
    /// False when this iPhone's posting key is known to be one that can only post.
    let canDelete: Bool
    let connectionName: String
    let savedConnection: ConnectionChoice?
    let changeConnection: (ConnectionChoice) throws -> Void
    let compose: () -> Void
    let signOut: () throws -> Void
    let deleteCast: (FeedCast) async throws -> Void
    /// Opens the Networks sheet from the title, once this iPhone has a network.
    let switchNetwork: (() -> Void)?
    let othersHaveNews: Bool

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var model: FeedModel
    @State private var showSettings = false
    @State private var confirmingDelete: FeedCast?
    @State private var deleting: Set<String> = []
    @State private var deleteError: String?
    @State private var showDeleteHelp = false

    private static let feedTop = "feed-top"

    init(directory: URL, fid: UInt64, username: String?, signedIn: Bool, signOutBlock: String?, notice: String?, latestPost: FeedCast?,
         canDelete: Bool, connectionName: String, savedConnection: ConnectionChoice?,
         changeConnection: @escaping (ConnectionChoice) throws -> Void, compose: @escaping () -> Void,
         signOut: @escaping () throws -> Void, deleteCast: @escaping (FeedCast) async throws -> Void,
         switchNetwork: (() -> Void)? = nil, othersHaveNews: Bool = false) {
        _model = State(initialValue: FeedModel(directory: directory, ownFID: fid, ownHandle: username))
        self.username = username
        self.signedIn = signedIn
        self.signOutBlock = signOutBlock
        self.notice = notice
        self.latestPost = latestPost
        self.canDelete = canDelete
        self.connectionName = connectionName
        self.savedConnection = savedConnection
        self.changeConnection = changeConnection
        self.compose = compose
        self.signOut = signOut
        self.deleteCast = deleteCast
        self.switchNetwork = switchNetwork
        self.othersHaveNews = othersHaveNews
    }

    var body: some View {
        let casts = model.casts
        let marker = model.marker(in: casts)
        VStack(spacing: 0) {
            header
            FatlineDivider()
            if let problem = model.problem, !casts.isEmpty {
                FeedProblemBanner(problem: problem, lastChecked: model.lastChecked, checking: model.loading) {
                    Platform.haptic(.tap)
                    Task { await model.refresh(reason: "pull") }
                }
                FatlineDivider()
            }
            ScrollViewReader { scroller in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if let notice {
                            FeedMessage(text: notice)
                            CastDivider()
                        }
                        if let status = model.status, !casts.isEmpty {
                            FeedMessage(text: status)
                            CastDivider()
                        }
                        ForEach(casts) { cast in
                            // One view per cast, so the feed can tell which cast is at the top of the screen.
                            VStack(spacing: 0) {
                                if cast.id == marker { FeedMarker() }
                                let handle = model.handle(for: cast.fid)
                                CastRow(cast: cast, handle: handle)
                                    .opacity(deleting.contains(cast.hash) ? 0.4 : 1)
                                    .contextMenu { menu(for: cast, handle: handle) }
                                    .accessibilityIdentifier("feed-cast")
                                if cast.id != casts.last?.id { CastDivider() }
                            }
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.bottom, FatlineStyle.plusClearance)
                    .id(Self.feedTop)
                }
                .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.2) { visible in
                    let visible = Set(visible)
                    if let top = casts.first(where: { visible.contains($0.id) }) { model.sawTop(top) }
                }
                .onChange(of: model.opening, initial: true) { _, cast in
                    guard let cast else { return }
                    // After this pass, so the saved casts are laid out before the scroll.
                    Task {
                        // The marker is part of the cast's own view, so it shows at the top when it's there.
                        scroller.scrollTo(cast, anchor: .top)
                        model.opened()
                    }
                }
                .onChange(of: casts.first?.id) { old, _ in
                    // New casts go in above. Unless the reader was at the top, keep what they were reading in place.
                    guard let reading = model.reading, reading != old else { return }
                    scroller.scrollTo(reading, anchor: .top)
                }
                .onChange(of: latestPost) { _, post in
                    guard let post else { return }
                    model.addPosted(post)
                    model.sawTop(post)
                    scroller.scrollTo(Self.feedTop, anchor: .top)
                    Task { await model.refresh(reason: "post") }
                }
            }
            .overlay {
                if casts.isEmpty {
                    Text(emptyMessage)
                        .font(FatlineStyle.body)
                        .foregroundStyle(FatlineStyle.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, FatlineStyle.gutter)
                        .allowsHitTesting(false)
                }
            }
            .refreshable { await model.refresh(reason: "pull") }
            .overlay(alignment: .bottomTrailing) { ComposeButton(action: compose) }
        }
        .background(FatlineStyle.paper.ignoresSafeArea())
        .foregroundStyle(FatlineStyle.ink)
        .task { await model.start(signedIn: signedIn) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refreshIfStale() } } else { model.savePlace() }
        }
        .sheet(isPresented: $showSettings) {
            SettingsSheet(
                model: model, username: username, connectionName: connectionName, savedConnection: savedConnection,
                changeConnection: changeConnection, signOutBlock: signOutBlock, signOut: signOut
            )
            .tint(FatlineStyle.action)
        }
        .confirmationDialog(
            "Delete this cast?",
            isPresented: Binding(get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } }),
            titleVisibility: .visible,
            presenting: confirmingDelete
        ) { cast in
            Button("Delete", role: .destructive) { Task { await delete(cast) } }
        } message: { _ in
            Text("Farcaster apps will stop showing it. This can’t be undone.")
        }
        .alert("Couldn’t delete the cast", isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(deleteError ?? "")
        }
        .alert("Sign in again to delete", isPresented: $showDeleteHelp) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(PostingError.postOnlyKey.errorDescription ?? "")
        }
    }

    /// The long-press menu on a cast.
    @ViewBuilder private func menu(for cast: FeedCast, handle: String) -> some View {
        if !cast.text.isEmpty {
            Button("Copy Text", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = cast.text
                Platform.haptic(.tap)
            }
        }
        if let url = cast.farcasterURL(handle: handle) {
            Button("Copy Link", systemImage: "link") {
                UIPasteboard.general.string = url.absoluteString
                Platform.haptic(.tap)
            }
            Button("Open in Farcaster", systemImage: "arrow.up.forward.app") { openURL(url) }
        }
        if model.isOwn(cast), !deleting.contains(cast.hash) {
            Divider()
            Button("Delete", systemImage: "trash", role: .destructive) {
                if canDelete { confirmingDelete = cast } else { showDeleteHelp = true }
            }
        }
    }

    private func delete(_ cast: FeedCast) async {
        deleting.insert(cast.hash)
        defer { deleting.remove(cast.hash) }
        do {
            try await deleteCast(cast)
            model.removeDeleted(cast)
        } catch PostingError.postOnlyKey {
            Platform.haptic(.problem)
            showDeleteHelp = true
        } catch {
            Platform.haptic(.problem)
            deleteError = error.localizedDescription
        }
    }

    private var emptyMessage: String {
        if let status = model.status { return status }
        if model.loading { return "Loading…" }
        if model.problem != nil { return "Couldn’t load the feed. Pull down to try again." }
        if model.hasLoadedFeed, model.people.isEmpty {
            return "You don’t follow anyone yet. Follow people in the Farcaster app, then refresh People."
        }
        if model.hasLoadedFeed, model.names.isEmpty { return "Everyone is hidden." }
        return "No recent casts."
    }

    private var header: some View {
        Group {
            if let switchNetwork {
                NetworkTitleButton(membership: nil, othersHaveNews: othersHaveNews, action: switchNetwork)
            } else {
                Image("Portal")
                    .resizable()
                    .frame(width: 36, height: 36)
                    .clipShape(.circle)
                    .accessibilityLabel("Fatline feed")
            }
        }
        .frame(maxWidth: .infinity, minHeight: FatlineStyle.headerHeight)
        .overlay(alignment: .trailing) {
            Button { showSettings = true } label: {
                Image(systemName: "ellipsis")
                    .font(FatlineStyle.markGlyph)
                    .foregroundStyle(FatlineStyle.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("settings")
            // The 15-point glyph is centered in its 44-point target, which puts its edge on the gutter.
            .padding(.trailing, 1.5)
        }
        .padding(.bottom, FatlineStyle.headerGap)
    }
}

/// Everything behind the three dots. Sign Out sits apart at the bottom and asks first, so it's hard to
/// reach by accident.
private struct SettingsSheet: View {
    let model: FeedModel
    let username: String?
    let connectionName: String
    let savedConnection: ConnectionChoice?
    let changeConnection: (ConnectionChoice) throws -> Void
    let signOutBlock: String?
    let signOut: () throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false
    @State private var signOutError: String?
    @State private var copied = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                FatlineDivider()
                ScrollView {
                    VStack(spacing: 0) {
                        if let username {
                            account(username)
                            CastDivider()
                        }
                        NavigationLink { PeopleList(model: model) } label: { row("People") }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("settings-people")
                        CastDivider()
                        NavigationLink {
                            ConnectionForm(settings: savedConnection) { choice in
                                try changeConnection(choice)
                                dismiss()
                            }
                        } label: { row("Connection", value: connectionName) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("settings-connection")
                        CastDivider()
                        diagnostics
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { signOutSection }
            }
            .foregroundStyle(FatlineStyle.ink)
            .background(FatlineStyle.paper.ignoresSafeArea())
            .fatlineTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: {
                        Text("Done").font(FatlineStyle.body)
                    }
                }
            }
        }
        .alert("Couldn’t sign out", isPresented: Binding(get: { signOutError != nil }, set: { if !$0 { signOutError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(signOutError ?? "")
        }
    }

    private func account(_ username: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(verbatim: username)
                .font(FatlineStyle.bodyStrong)
            Spacer(minLength: 8)
            Text("Signed in")
                .font(FatlineStyle.meta)
                .foregroundStyle(FatlineStyle.secondary)
        }
        .frame(minHeight: 44)
        .padding(.horizontal, FatlineStyle.gutter)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private func row(_ title: String, value: String? = nil) -> some View {
        HStack(spacing: 12) {
            Text(title)
                .font(FatlineStyle.body)
            Spacer(minLength: 8)
            if let value {
                Text(value)
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.secondary)
            }
            Image(systemName: "chevron.right")
                .font(FatlineStyle.metaStrong)
                .foregroundStyle(FatlineStyle.secondary)
                .accessibilityHidden(true)
        }
        .frame(minHeight: 44)
        .padding(.horizontal, FatlineStyle.gutter)
        .padding(.vertical, 6)
        .contentShape(.rect)
    }

    private var diagnostics: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                UIPasteboard.general.string = model.diagnostics
                Platform.haptic(.tap)
                copied = true
                UIAccessibility.post(notification: .announcement, argument: "Diagnostics copied")
            } label: {
                Text(copied ? "Copied" : "Copy Diagnostics")
                    .font(FatlineStyle.body)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("copy-diagnostics")
            .task(id: copied) {
                guard copied else { return }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                copied = false
            }
            Text("Paste into a message or TestFlight feedback. Includes your Farcaster ID and feed loading results, but no keys, drafts, or cast text.")
                .font(FatlineStyle.meta)
                .foregroundStyle(FatlineStyle.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: FeedModel.versionLine)
                .font(FatlineStyle.meta)
                .foregroundStyle(FatlineStyle.secondary)
        }
        .padding(.horizontal, FatlineStyle.gutter)
        .padding(.top, 24)
        .padding(.bottom, FatlineStyle.rowPadding)
    }

    private var signOutSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            CastDivider()
            Button { confirmingSignOut = true } label: {
                Text("Sign Out")
                    .font(FatlineStyle.body)
                    .foregroundStyle(signOutBlock == nil ? Color(uiColor: .systemRed) : FatlineStyle.secondary)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, FatlineStyle.gutter)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(signOutBlock != nil)
            .accessibilityIdentifier("sign-out")
            .confirmationDialog("Sign out of Fatline?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) {
                    do { try signOut() } catch { signOutError = error.localizedDescription }
                }
            } message: {
                Text("This removes the posting key from this iPhone and keeps this account’s draft.")
            }
            if let signOutBlock {
                Text(signOutBlock)
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, FatlineStyle.gutter)
            }
        }
        .padding(.bottom, 8)
        .background(FatlineStyle.paper)
    }
}

private struct PeopleList: View {
    let model: FeedModel

    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            FatlineDivider()
            ScrollView {
                VStack(spacing: 0) {
                    if let message = error ?? (model.peopleRefreshFailed ? "Couldn’t refresh. Try again in a minute." : nil) {
                        FeedMessage(text: message)
                        CastDivider()
                    }
                    ForEach(model.people) { person in
                        row(person)
                        if person.id != model.people.last?.id { CastDivider() }
                    }
                    Text("To change who you follow, use the Farcaster app.")
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, FatlineStyle.gutter)
                        .padding(.vertical, FatlineStyle.rowPadding)
                }
            }
        }
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .fatlineTitle("People")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                refreshButton
            }
            .sharedBackgroundVisibility(.hidden)
        }
    }

    /// Only this button rereads the list, because it costs credits and the feed doesn't need it to stay current.
    private var refreshButton: some View {
        Button {
            Platform.haptic(.tap)
            Task { await model.refreshPeople() }
        } label: {
            ZStack {
                Image(systemName: "arrow.clockwise")
                    .font(FatlineStyle.body)
                    .foregroundStyle(FatlineStyle.secondary)
                    .opacity(model.refreshingPeople ? 0 : 1)
                if model.refreshingPeople { ProgressView().controlSize(.small) }
            }
        }
        .disabled(model.refreshingPeople)
        .accessibilityLabel(model.refreshingPeople ? "Refreshing people you follow" : "Refresh people you follow")
        .accessibilityIdentifier("refresh-people")
    }

    private func row(_ person: FeedModel.Person) -> some View {
        let hidden = model.isHidden(person)
        let action = hidden ? "Unhide" : "Hide"
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(person.handle)
                .font(FatlineStyle.bodyStrong)
                .foregroundStyle(hidden ? FatlineStyle.secondary : FatlineStyle.ink)
            Spacer(minLength: 8)
            Button {
                do {
                    try model.toggleVisibility(person)
                    Platform.haptic(.pick)
                    error = nil
                } catch { self.error = "Couldn’t save the change." }
            } label: {
                Text(action)
                    .font(FatlineStyle.body)
                    .foregroundStyle(hidden ? FatlineStyle.ink : FatlineStyle.secondary)
                    .frame(minWidth: 72, minHeight: 44, alignment: .trailing)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(action) \(person.handle)")
        }
        .padding(.horizontal, FatlineStyle.gutter)
        .padding(.vertical, 6)
    }
}

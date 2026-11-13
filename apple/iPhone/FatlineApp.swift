import SwiftUI

@main
struct FatlineApp: App {
    var body: some Scene {
        WindowGroup { AppRoot() }
    }
}

/// The splash state belongs to a view, not the App: an animated change to App state doesn't reach
/// the window's views, so the splash would vanish without fading. It stays false for as long as
/// the window lives, so returning from the background never replays the splash.
private struct AppRoot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showSplash = true
    @State private var splashGone = false

    var body: some View {
        Composer(splashGone: splashGone)
            .overlay {
                if showSplash {
                    SplashScreen()
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 1.12)))
                }
            }
            .statusBarHidden(showSplash)
            .task {
                try? await Task.sleep(for: .seconds(0.4))
                withAnimation(.easeOut(duration: 0.3)) { showSplash = false } completion: { splashGone = true }
            }
    }
}

/// Matches the system launch screen in Info.plist exactly, so the handoff between them is invisible.
private struct SplashScreen: View {
    var body: some View {
        ZStack {
            Color("SplashBackground")
            Image("SplashMark")
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// The focus state lives here because a full-screen cover is a separate presentation:
/// focus state owned by the view that presents the cover doesn't reach the editor.
private struct CastEditor: View {
    @Binding var text: String
    let ready: Bool
    @FocusState private var focused: Bool

    var body: some View {
        TextEditor(text: $text)
            .font(FatlineStyle.body)
            .lineSpacing(FatlineStyle.bodyLineSpacing)
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .focused($focused)
            .accessibilityLabel("Cast draft")
            .disabled(!ready)
            .overlay(alignment: .topLeading) {
                if ready && text.isEmpty {
                    Text("Write a cast…")
                        .font(FatlineStyle.body)
                        .foregroundStyle(FatlineStyle.secondary)
                        .padding(.leading, 5)
                        .padding(.top, 8)
                        .accessibilityHidden(true)
                        .allowsHitTesting(false)
                }
            }
            .task(id: ready) { focused = ready }
    }
}

private struct Composer: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var session = PostingSession()
    /// Private networks, beside Farcaster. Nothing shows them yet.
    @State private var networks = NetworkModel()
    @State private var showNetworks = false
    /// Add Network was tapped in the sheet, so the join steps open once it has closed.
    @State private var addAfterSheet = false
    @State private var addingNetwork = false
    @State private var showDiscardRetry = false
    @State private var builds = BuildCheck()
    /// An alert shown during the splash would sit over it.
    let splashGone: Bool

    /// Changing the connection replaces the feed, so nothing keeps reading through the old one.
    private struct FeedIdentity: Hashable {
        let fid: UInt64
        let connection: Connection
    }

    private static let composerInset = FatlineStyle.gutter

    /// What the network reads restart on: another network, the app coming forward, or one joined or left.
    private struct NetworkPoll: Hashable {
        let host: String?
        let active: Bool
        let count: Int
    }

    var body: some View {
        Group {
            if let membership = networks.selected {
                // Its own identity, so switching networks starts clean.
                NetworkHome(membership: membership) { showNetworks = true }
                    .id(membership.host)
            } else if session.account?.fid != nil, session.savedConnection == nil, !Connection.isSetByLaunch {
                ConnectionSetup(finish: session.useConnection)
            } else if let fid = session.account?.fid {
                FeedHome(
                    directory: PostingSession.accountFolder(fid),
                    fid: fid,
                    username: session.account?.username,
                    signedIn: session.signedInNow,
                    signOutBlock: session.signOutBlock,
                    notice: session.keyInactive ? PostingError.inactiveKey.errorDescription : nil,
                    latestPost: session.latestPost,
                    canDelete: session.keyCanDelete != false,
                    connectionName: session.connection.name,
                    savedConnection: session.savedConnection,
                    changeConnection: session.useConnection,
                    compose: session.openComposer,
                    signOut: session.signOut,
                    deleteCast: session.deleteCast,
                    switchNetwork: networks.memberships.isEmpty ? nil : { showNetworks = true },
                    othersHaveNews: networks.othersHaveNews
                )
                .id(FeedIdentity(fid: fid, connection: session.connection))
                .overlay(alignment: .bottom) {
                    // Sits above the floating compose button.
                    if !session.showComposer { postToastHost.padding(.bottom, FatlineStyle.plusClearance) }
                }
            } else {
                GettingStarted(session: session, switchNetwork: networks.memberships.isEmpty ? nil : { showNetworks = true }) {
                    recoveryForm
                }
            }
        }
        .tint(FatlineStyle.action)
        .sheet(isPresented: $showNetworks, onDismiss: {
            if addAfterSheet {
                addAfterSheet = false
                addingNetwork = true
            }
        }) {
            NetworksSheet {
                addAfterSheet = true
                showNetworks = false
            }
            .tint(FatlineStyle.action)
        }
        .fullScreenCover(isPresented: $addingNetwork) {
            AddNetworkFlow { addingNetwork = false }
        }
        // Reads the network showing, and looks for news in the others, now and each minute while the
        // app is in front. Coming forward starts it again, so it reads right away.
        .task(id: NetworkPoll(host: networks.selectedHost, active: scenePhase == .active, count: networks.memberships.count)) {
            guard scenePhase == .active, !networks.memberships.isEmpty else { return }
            while !Task.isCancelled {
                await networks.refresh()
                await networks.checkOthers()
                try? await Task.sleep(for: .seconds(NetworkModel.pollInterval))
            }
        }
        .fullScreenCover(isPresented: Bindable(session).showComposer) {
            composerSurface.tint(FatlineStyle.action)
        }
        .task(id: session.draft) {
            // A change to the draft cancels this wait, so a save happens once typing pauses.
            // Cancel, Sign Out, and leaving the app save right away.
            do { try await Task.sleep(for: .seconds(0.5)) } catch { return }
            if session.ready { session.saveDraft() }
        }
        .onAppear(perform: session.loadSavedAccount)
        .task(id: session.account?.fid) { await session.checkKey() }
        .task { await builds.runIfDue() }
        #if DEBUG
        .task { await networks.joinFromLaunch() }
        #endif
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else {
                if session.ready { session.saveDraft() }
                return
            }
            session.checkKeyIfDue()
            Task { await builds.runIfDue() }
        }
        // The composer is a full-screen cover, so the offer waits until it closes.
        .alert(builds.offered.map { "Fatline build \($0.build) is available" } ?? "", isPresented: Binding(
            get: { builds.offered != nil && splashGone && !session.showComposer },
            set: { if !$0 { builds.dismiss() } }
        ), presenting: builds.offered) { offer in
            Button("Open TestFlight") { openURL(offer.link) }
            Button("Later", role: .cancel) {}
        } message: { _ in
            Text("You have build \(builds.current).")
        }
        // Last, so the covers and sheets above have it too.
        .environment(networks)
    }

    private var composerSurface: some View {
        VStack(spacing: 0) {
            composerHeader
            CastEditor(text: Bindable(session).draft, ready: session.ready)
                .padding(.horizontal, Self.composerInset - 5)
                // The editor's own 8-point inset puts the first line at the same height as a feed row.
                .padding(.top, FatlineStyle.rowPadding - 8)
        }
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        // One tick on going over the limit, the moment Post turns off.
        .onChange(of: session.draft.utf8.count > 320) { _, over in
            if over { Platform.haptic(.pick) }
        }
        .confirmationDialog("Stop retrying this cast?", isPresented: $showDiscardRetry) {
            Button("Stop Retrying", role: .destructive, action: session.discardRetry)
        } message: {
            Text("Snapchain may already have received it. Your draft stays here.")
        }
        .overlay(alignment: .bottom) {
            // The feed takes over the toast as soon as the composer starts closing.
            if session.showComposer { postToastHost.padding(.bottom, 12) }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // Keeps the row's height when it is empty, so toasts always sit in the same place.
            composerStatus
                .font(FatlineStyle.body)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, Self.composerInset)
        }
    }

    /// The feed and the composer each host this, because a full-screen cover hides whatever is behind it.
    @ViewBuilder private var postToastHost: some View {
        if let toast = session.postToast {
            FeedToastView(toast: toast)
                .padding(.horizontal, Self.composerInset)
                .allowsHitTesting(false)
                .transition(.opacity)
                .task(id: toast.id) {
                    do {
                        try await Task.sleep(for: .seconds(toast.detail == nil ? 4 : 6))
                        if session.postToast?.id == toast.id { session.setPostToast(nil) }
                    } catch { }
                }
        }
    }

    private var recoveryForm: some View {
        RecoveryPhraseForm(
            busy: session.busy, error: session.recoveryError, hasPendingRegistration: session.account?.registration != nil,
            connect: importPhrase, retry: { Task { await session.completeRegistration() } }
        )
    }

    /// Signs in, and approves this iPhone for networks with the same phrase, so joining one later
    /// doesn't ask for it again. The phrase isn't kept. As the Mac's sign-in does.
    private func importPhrase(_ phrase: String) {
        session.importPhrase(phrase)
        let networks = networks
        if networks.needsPhrase { Task { try? await networks.approveDevice(phrase: phrase) } }
    }

    private var composerHeader: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button("Cancel", action: session.cancelComposer)
            .font(FatlineStyle.body)
            .frame(minHeight: 44)
            .disabled(session.busy)
            Spacer(minLength: 4)
            if session.draft.utf8.count >= 280 {
                Text("\(session.draft.utf8.count) / 320")
                    .font(FatlineStyle.meta)
                    .monospacedDigit()
                    .foregroundStyle(session.draft.utf8.count > 320 ? FatlineStyle.danger : FatlineStyle.secondary)
                    .accessibilityLabel("\(session.draft.utf8.count) of 320 bytes")
            }
            Button {
                Platform.haptic(.tap)
                Task { await session.send() }
            } label: {
                Text(session.activePostTitle ?? (session.account?.pending == nil ? "Post" : "Retry"))
            }
            // Wide enough for both labels, so the pill and the counter don't shift between them.
            .buttonStyle(FatlinePrimaryButton(compact: true, minWidth: 76, isWorking: session.activePostTitle != nil))
            .disabled(session.sendDisabled)
        }
        .frame(minHeight: FatlineStyle.headerHeight)
        .padding(.horizontal, Self.composerInset)
        .padding(.bottom, FatlineStyle.headerGap)
    }

    @ViewBuilder private var composerStatus: some View {
        if session.saveFailed {
            Button("Retry Save", action: session.saveDraft).frame(minHeight: 44)
        } else if !session.ready {
            Button("Retry Draft", action: session.loadDraft).frame(minHeight: 44)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let notice = session.notice {
                    Text(notice)
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.secondary)
                }
                if session.account?.pending != nil && !session.busy {
                    Button("Post Options") { showDiscardRetry = true }
                        .frame(minHeight: 44)
                }
            }
        }
    }
}

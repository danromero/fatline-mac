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

    var body: some View {
        Composer()
            .overlay {
                if showSplash {
                    SplashScreen()
                        .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 1.12)))
                }
            }
            .statusBarHidden(showSplash)
            .task {
                try? await Task.sleep(for: .seconds(0.4))
                withAnimation(.easeOut(duration: 0.3)) { showSplash = false }
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
    @State private var session = PostingSession()
    @State private var showDiscardRetry = false

    /// Changing the connection replaces the feed, so nothing keeps reading through the old one.
    private struct FeedIdentity: Hashable {
        let fid: UInt64
        let connection: Connection
    }

    private static let composerInset = FatlineStyle.gutter

    var body: some View {
        Group {
            if session.account?.fid != nil, session.savedConnection == nil, !Connection.isSetByLaunch {
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
                    deleteCast: session.deleteCast
                )
                .id(FeedIdentity(fid: fid, connection: session.connection))
                .overlay(alignment: .bottom) {
                    // Sits above the floating compose button, which is 56 points tall and 20 from the bottom.
                    if !session.showComposer { postToastHost.padding(.bottom, 88) }
                }
            } else {
                WelcomeFlow(session: session) { recoveryForm }
            }
        }
        .tint(FatlineStyle.action)
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
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else {
                if session.ready { session.saveDraft() }
                return
            }
            session.checkKeyIfDue()
        }
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
            connect: session.importPhrase, retry: { Task { await session.completeRegistration() } }
        )
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

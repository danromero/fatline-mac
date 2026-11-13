import AppKit
import SwiftUI

@main
struct FatlineApp: App {
    @NSApplicationDelegateAdaptor(FatlineAppDelegate.self) private var delegate
    @State private var state = AppState()

    var body: some Scene {
        // A Window scene, so there's only ever one feed window.
        Window("Fatline", id: "feed") {
            AppRoot()
                .environment(state)
                .frame(minWidth: 420, minHeight: 480 - FatlineStyle.headerHeight)
        }
        .defaultSize(width: 440, height: 780)
        .windowResizability(.contentMinSize)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands { FatlineCommands(state: state) }

        // A plain window, because a Settings scene stacks People's back and refresh buttons under the title.
        Window("Settings", id: "settings") {
            SettingsWindow()
                .environment(state)
        }
        .windowResizability(.contentSize)
        .windowToolbarStyle(.unified)
    }
}

/// What the menus need to know, published through the focused scene as menu commands expect.
struct MenuFlags: Equatable {
    let signedIn: Bool
    let hasFeed: Bool
    let composing: Bool
    /// The networks in the title menu, in order. Farcaster is ⌘1 and these follow.
    var networks: [String] = []
    var inNetwork = false
}

extension FocusedValues {
    @Entry var menuFlags: MenuFlags?
}

extension View {
    func publishesMenuFlags(_ state: AppState) -> some View {
        let network = state.networks.selected
        let flags = MenuFlags(
            signedIn: network.map { $0.status == .approved } ?? (state.session.account?.fid != nil),
            hasFeed: network != nil || state.model != nil,
            composing: state.session.showComposer || state.showNetworkComposer,
            networks: state.networks.memberships.map(\.host),
            inNetwork: network != nil
        )
        return focusedSceneValue(\.menuFlags, flags)
            .onChange(of: flags) { MenuFlags.refreshMenusSoon() }
            // Flags that are already right at launch never change, and they only count once a window is key.
            .onAppear { MenuFlags.refreshMenusSoon() }
            .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
                MenuFlags.refreshMenusSoon()
            }
    }
}

extension MenuFlags {
    /// SwiftUI only rebuilds its menu items when a menu opens, which would leave the keyboard
    /// shortcuts behind until then. This asks once new flags have had time to arrive.
    @MainActor
    static func refreshMenusSoon() {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(100))
            for item in NSApp.mainMenu?.items ?? [] {
                if let menu = item.submenu { menu.delegate?.menuNeedsUpdate?(menu) }
            }
        }
    }
}

private struct FatlineCommands: Commands {
    let state: AppState
    @FocusedValue(\.menuFlags) private var flags
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { openWindow(id: "settings") }
                .keyboardShortcut(",")
                .disabled(flags?.hasFeed != true)
        }
        CommandGroup(replacing: .newItem) {
            Button(flags?.inNetwork == true ? "New Post" : "New Cast", action: state.newPost)
                .keyboardShortcut("n")
                .disabled(flags?.signedIn != true || flags?.composing == true)
            Button("Add Network…") { state.addingNetwork = true }
                .keyboardShortcut("n", modifiers: [.command, .shift])
        }
        CommandGroup(before: .toolbar) {
            Button("Refresh") {
                Task {
                    if state.networks.selected != nil { await state.networks.refresh() } else { await state.model?.refresh(reason: "pull") }
                }
            }
            .keyboardShortcut("r")
            .disabled(flags?.hasFeed != true || flags?.composing == true)
            Divider()
            if let networks = flags?.networks, !networks.isEmpty {
                // Not while composing: a draft stays with the network it was written for.
                Button("Farcaster") { state.networks.select(nil) }
                    .keyboardShortcut("1")
                    .disabled(flags?.composing == true)
                ForEach(Array(networks.prefix(8).enumerated()), id: \.element) { index, host in
                    Button(state.networks.memberships.first { $0.host == host }?.label ?? host) { state.networks.select(host) }
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 2))))
                        .disabled(flags?.composing == true)
                }
                Divider()
            }
        }
        CommandMenu("Debug") {
            Button("Copy Diagnostics", action: state.copyDiagnostics)
                .disabled(flags?.hasFeed != true || flags?.composing == true)
            Button("Forget Networks on This Mac") { state.networks.forgetEverything() }
                .disabled((flags?.networks.isEmpty != false && state.networks.device == nil) || flags?.composing == true)
        }
        CommandGroup(replacing: .help) {}
    }
}

/// A change of account or connection replaces the feed, so nothing keeps reading through the old one.
private struct FeedOwner: Equatable {
    let fid: UInt64
    let connection: Connection
}

/// What the app's windows and menus share.
@MainActor
@Observable
final class AppState {
    let session = PostingSession()
    let networks = NetworkModel()
    let menuBar = MenuBarIcon()
    /// Add Network takes over the window, as setup does.
    var addingNetwork = false
    var showNetworkComposer = false
    /// Replies and Activity, pushed over the network's feed.
    var networkPath: [NetworkRoute] = []
    /// While first-run setup shows, the title stays empty, even once a network is joined in it.
    var settingUp = false
    /// Off until someone asks for it in Settings.
    var showsMenuBarIcon = UserDefaults.standard.bool(forKey: MenuBarIcon.shownKey) {
        didSet {
            UserDefaults.standard.set(showsMenuBarIcon, forKey: MenuBarIcon.shownKey)
            // The Dock is the only other way to reach the app.
            if !showsMenuBarIcon, !showsDockIcon { showsDockIcon = true } else { menuBar.apply() }
        }
    }
    var showsDockIcon = UserDefaults.standard.object(forKey: MenuBarIcon.dockKey) == nil
        || UserDefaults.standard.bool(forKey: MenuBarIcon.dockKey) {
        didSet {
            UserDefaults.standard.set(showsDockIcon, forKey: MenuBarIcon.dockKey)
            menuBar.apply()
        }
    }
    private(set) var model: FeedModel?
    private var modelOwner: FeedOwner?
    /// Casts being deleted, which stay dimmed in the feed until the network answers.
    var deleting: Set<String> = []
    var confirmingDelete: FeedCast?
    var deleteError: String?
    var showDeleteHelp = false

    init() {
        session.loadSavedAccount()
        openFeed()
    }

    var fid: UInt64? { session.account?.fid ?? Self.readOnlyFID }
    var username: String? { session.account?.username }

    /// Keeps the feed matched to whoever is signed in.
    func openFeed() {
        let owner = fid.map { FeedOwner(fid: $0, connection: session.connection) }
        guard owner != modelOwner else { return }
        modelOwner = owner
        confirmingDelete = nil
        deleteError = nil
        showDeleteHelp = false
        model = owner.map { FeedModel(directory: Self.accountFolder($0.fid), ownFID: $0.fid, ownHandle: username) }
    }

    /// ⌘N and the plus: a post in the network that's showing, or a cast on Farcaster.
    func newPost() {
        if networks.selected != nil { showNetworkComposer = true } else { session.openComposer() }
    }

    /// Opens the network's admin pages in the browser, signed in through a one-time link.
    func manageNetwork() {
        Task {
            do { NSWorkspace.shared.open(try await networks.adminLink()) } catch { networks.toast = error.localizedDescription }
        }
    }

    func leaveNetwork() {
        guard let selected = networks.selected else { return }
        Task {
            if selected.status == .approved {
                do { try await networks.leave() } catch { networks.toast = error.localizedDescription }
            } else {
                networks.forget(selected.host)
            }
        }
    }

    func copyDiagnostics() {
        guard let model else { return }
        Platform.copyToClipboard(model.diagnostics)
        session.setPostToast(PostToast(detail: nil, confirmation: "Diagnostics copied"))
    }

    /// True until someone has chosen how this app reaches Farcaster.
    var needsConnection: Bool {
        session.savedConnection == nil && !Connection.isSetByLaunch
    }

    static func accountFolder(_ fid: UInt64) -> URL {
        PostingSession.accountFolder(fid)
    }

    /// `-FatlineFID 3` opens that account's public feed, read-only and with no sign-in.
    private static var readOnlyFID: UInt64? {
        #if DEBUG
        UserDefaults.standard.string(forKey: "FatlineFID").flatMap(UInt64.init)
        #else
        nil
        #endif
    }
}

private struct AppRoot: View {
    @Environment(AppState.self) private var state
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            if state.addingNetwork {
                AddNetworkFlow()
            } else if let network = state.networks.selected {
                NetworkWindow(membership: network)
                    .id(network.host)
            } else if state.needsConnection, state.model != nil {
                ConnectionSetup(finish: state.session.useConnection)
            } else if let model = state.model {
                FeedWindow(model: model)
                    .id(ObjectIdentifier(model))
            } else {
                GettingStarted(farcasterOnly: !state.networks.memberships.isEmpty)
            }
        }
        .publishesMenuFlags(state)
        .feedTitleBar(showsPortal: !state.addingNetwork && !state.settingUp
            && (state.networks.selected != nil || !state.networks.memberships.isEmpty || (state.model != nil && !state.needsConnection)))
        .sheet(isPresented: Bindable(state).showNetworkComposer) { NetworkComposerSheet() }
        .onChange(of: state.networks.selectedHost) { state.networkPath = [] }
        // News in the networks that aren't showing, for the dots on the title and in its menu.
        .task(id: state.networks.memberships.map(\.host)) {
            while !Task.isCancelled {
                await state.networks.checkOthers()
                try? await Task.sleep(for: .seconds(NetworkModel.pollInterval))
            }
        }
        .onAppear { state.menuBar.start(state, openWindow: openWindow) }
        // Closing the feed quits even with Settings open, so no window outlives the account it shows.
        // With the menu bar icon on, closing only hides the window, so this never runs.
        .onDisappear { if !state.showsMenuBarIcon { NSApp.terminate(nil) } }
        .onChange(of: state.session.account?.fid) { state.openFeed() }
        .onChange(of: state.session.connection) { state.openFeed() }
        .task(id: state.session.account?.fid) { await state.session.checkKey() }
        .task { UpdateCheck.runIfDue() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            state.session.checkKeyIfDue()
            UpdateCheck.runIfDue()
        }
    }
}

/// Nothing needs to keep running once the feed window is gone, unless the menu bar icon is on.
final class FatlineAppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // There's one feed window, so the tab commands would have nothing to do.
        NSWindow.allowsAutomaticWindowTabbing = false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !UserDefaults.standard.bool(forKey: MenuBarIcon.shownKey)
    }

    /// A click on the Dock icon brings back a feed window the menu bar icon hid.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        guard !hasVisibleWindows, let menuBar = MenuBarIcon.current, menuBar.feedWindow != nil else { return true }
        menuBar.showFeed()
        return false
    }
}

import AppKit
import SwiftUI

/// The one feed window: a single column of casts on Fatline's paper.
struct FeedWindow: View {
    let model: FeedModel
    @Environment(AppState.self) private var state

    @State private var position = ScrollPosition()

    var body: some View {
        let casts = model.casts
        let marker = model.marker(in: casts)
        VStack(spacing: 0) {
            FatlineDivider()
            FeedBanner(model: model, casts: casts)
            ScrollView {
                LazyVStack(spacing: 0) {
                    FeedStatusRow(model: model, casts: casts)
                    ForEach(casts) { cast in
                        // One view per cast, so the feed can tell which cast is at the top of the window.
                        VStack(spacing: 0) {
                            if cast.id == marker { FeedMarker() }
                            let handle = model.handle(for: cast.fid)
                            CastRow(cast: cast, handle: handle)
                                .opacity(state.deleting.contains(cast.hash) ? 0.4 : 1)
                                .contextMenu { CastMenu(cast: cast, handle: handle, model: model) }
                                .accessibilityActions { CastMenu(cast: cast, handle: handle, model: model) }
                                .accessibilityIdentifier("feed-cast")
                            if cast.id != casts.last?.id { CastDivider() }
                        }
                    }
                }
                .scrollTargetLayout()
                .frame(maxWidth: FatlineStyle.columnMaxWidth)
                .padding(.bottom, 76) // Leaves room to scroll the last cast clear of the floating plus.
                .frame(maxWidth: .infinity)
            }
            .scrollPosition($position)
            .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.2) { visible in
                let visible = Set(visible)
                if let top = casts.first(where: { visible.contains($0.id) }) { model.sawTop(top) }
            }
            .onChange(of: model.opening, initial: true) { _, cast in
                guard let cast else { return }
                // After this pass, so the saved casts are laid out before the scroll.
                Task {
                    // The marker is part of the cast's own view, so it shows at the top when it's there.
                    position.scrollTo(id: cast, anchor: .top)
                    model.opened()
                }
            }
            .onChange(of: casts.first?.id) { old, _ in
                // New casts go in above. Unless the reader was at the top, keep what they were reading in place.
                guard let reading = model.reading, reading != old else { return }
                position.scrollTo(id: reading, anchor: .top)
            }
            .modifier(FeedKeyboardScrolling(position: $position, composing: state.session.showComposer))
            .onChange(of: state.session.latestPost) { _, post in
                guard let post else { return }
                model.addPosted(post)
                model.sawTop(post)
                position.scrollTo(edge: .top)
                Task { await model.refresh(reason: "post") }
            }
            .overlay {
                if casts.isEmpty { FeedEmptyMessage(model: model) }
            }
            .overlay(alignment: .bottom) {
                ComposerPlus()
                    .frame(maxWidth: FatlineStyle.columnMaxWidth, alignment: .trailing)
            }
            .overlay(alignment: .top) {
                FeedToastHost()
                    .frame(maxWidth: FatlineStyle.columnMaxWidth)
                    .padding(.top, 4)
            }
        }
        .background(FatlineStyle.paper)
        .foregroundStyle(FatlineStyle.ink)
        .tint(FatlineStyle.action)
        .sheet(isPresented: Bindable(state.session).showComposer) { ComposerSheet() }
        .modifier(CastDeleteAlerts(model: model))
        .task { await model.start(signedIn: state.session.signedInNow) }
        // Not scenePhase, because a window left visible behind another app never stops being active.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await model.refreshIfStale() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willResignActiveNotification)) { _ in model.savePlace() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in model.savePlace() }
    }
}

/// The arrow keys, Page Up and Down, Space, Home, and End scroll the feed, as in any Mac reader.
private struct FeedKeyboardScrolling: ViewModifier {
    @Binding var position: ScrollPosition
    let composing: Bool
    @State private var geometry: ScrollGeometry?
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: ScrollGeometry.self) { $0 } action: { _, new in geometry = new }
            .focusable()
            .focusEffectDisabled()
            .focused($focused)
            .onAppear { focused = true }
            .onChange(of: composing) { _, open in if !open { focused = true } }
            .onKeyPress(phases: [.down, .repeat], action: handle)
    }

    private func handle(_ press: KeyPress) -> KeyPress.Result {
        guard press.modifiers.isDisjoint(with: [.command, .option, .control]), let geometry else { return .ignored }
        let page = max(geometry.containerSize.height - 48, 48)
        let distance: CGFloat
        switch press.key {
        case .upArrow: distance = -40
        case .downArrow: distance = 40
        case .pageUp: distance = -page
        case .pageDown: distance = page
        case .space: distance = press.modifiers.contains(.shift) ? -page : page
        case .home:
            glide { $0.scrollTo(edge: .top) }
            return .handled
        case .end:
            glide { $0.scrollTo(edge: .bottom) }
            return .handled
        default:
            return .ignored
        }
        let lowest = max(geometry.contentSize.height + geometry.contentInsets.bottom - geometry.containerSize.height, 0)
        let target = min(max(geometry.contentOffset.y + distance, -geometry.contentInsets.top), lowest)
        if abs(distance) > 40 {
            glide { $0.scrollTo(y: target) }
        } else {
            position.scrollTo(y: target) // Held arrow keys repeat too quickly to animate each step.
        }
        return .handled
    }

    private func glide(_ move: (inout ScrollPosition) -> Void) {
        withAnimation(Platform.reduceMotion ? nil : .easeOut(duration: 0.18)) { move(&position) }
    }
}

extension View {
    /// Paper runs under the title bar, with the portal centered on it once the feed is showing.
    /// Sign-in and the feed share this one title bar, so its height can't change between them.
    func feedTitleBar(showsPortal: Bool) -> some View {
        toolbar {
            // The portal sits on the paper, so it doesn't take the toolbar's own background.
            ToolbarItem(placement: .principal) {
                // The portal, or a menu that switches networks once there are any.
                TitleSwitcher(showsPortal: showsPortal)
                    .accessibilityHidden(!showsPortal)
            }
            .sharedBackgroundVisibility(.hidden)
            // Kept in place on sign-in too, hidden, for the same reason as the portal.
            ToolbarItem(placement: .primaryAction) {
                SettingsButton()
                    .opacity(showsPortal ? 1 : 0)
                    .disabled(!showsPortal)
                    .accessibilityHidden(!showsPortal)
            }
            .sharedBackgroundVisibility(.hidden)
        }
        .toolbarBackground(FatlineStyle.paper, for: .windowToolbar)
        .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
    }
}

/// Settings, on the title bar's trailing side, the same as Settings… and ⌘,.
struct SettingsButton: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button { openWindow(id: "settings") } label: {
            Image(systemName: "gearshape")
                .font(.system(size: 15)) // layout-ok: a bar glyph, the same size as the network title bar's tray
                .foregroundStyle(FatlineStyle.secondary)
                .frame(width: FatlineStyle.avatarSize, height: FatlineStyle.avatarSize)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("Settings")
        .accessibilityLabel("Settings")
    }
}

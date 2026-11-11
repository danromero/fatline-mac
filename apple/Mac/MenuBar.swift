import AppKit
import ServiceManagement
import SwiftUI

/// Decides when the menu bar icon shows its dot: someone else has posted since the feed was last in front.
struct NewCastWatch {
    private(set) var noticed: FeedPlace?

    /// The first feed to arrive counts as noticed, so the dot only ever means "since then".
    mutating func showsDot(newest: FeedPlace?, inFront: Bool) -> Bool {
        guard let newest else { return false }
        guard !inFront, let noticed else {
            if noticed.map(newest.isNewer) ?? true { noticed = newest }
            return false
        }
        return newest.isNewer(than: noticed)
    }
}

/// Opening Fatline when this account logs in to the Mac. The system keeps the answer.
enum LoginItem {
    static var isOn: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}

/// The optional menu bar icon. A click shows or hides the feed window, and a right-click opens a short
/// menu. While it's on, the feed is checked every ten minutes and closing the window only hides it.
@MainActor
final class MenuBarIcon: NSObject {
    static let shownKey = "showInMenuBar"
    static let dockKey = "showInDock"
    static let checkEvery: TimeInterval = 10 * 60
    private(set) static weak var current: MenuBarIcon?

    private weak var state: AppState?
    private var openWindow: OpenWindowAction?
    private var item: NSStatusItem?
    private var dot: NSView?
    private var watch = NewCastWatch()
    private var checks: Task<Void, Never>?
    private var closer: FeedWindowCloser?
    private var started = false

    func start(_ state: AppState, openWindow: OpenWindowAction) {
        self.openWindow = openWindow
        guard !started else { return }
        started = true
        self.state = state
        Self.current = self
        let center = NotificationCenter.default
        for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
                     NSWindow.didBecomeKeyNotification] {
            center.addObserver(self, selector: #selector(windowsChanged), name: name, object: nil)
        }
        watchFeed()
        apply()
    }

    /// Matches the icon, the checks, and the Dock to Settings.
    func apply() {
        guard let state else { return }
        if state.showsMenuBarIcon { addItem() } else { removeItem() }
        let policy: NSApplication.ActivationPolicy = state.showsDockIcon ? .regular : .accessory
        if NSApp.activationPolicy() != policy {
            let visible = NSApp.windows.filter { $0.isVisible && $0.canBecomeKey }
            NSApp.setActivationPolicy(policy)
            // Leaving the Dock sends the app's windows behind everything else.
            Task { @MainActor in
                NSApp.activate()
                visible.forEach { $0.makeKeyAndOrderFront(nil) }
            }
        }
        update()
    }

    var feedWindow: NSWindow? {
        NSApp.windows.first { $0.identifier?.rawValue.hasPrefix("feed") == true }
    }

    func showFeed() {
        guard let window = feedWindow else { return }
        NSApp.unhide(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if let model = state?.model { Task { await model.refreshIfStale() } }
        update()
    }

    func hideFeed() {
        guard let window = feedWindow else { return }
        state?.model?.savePlace()
        window.orderOut(nil)
        // With nothing left on screen, the app that was in front before gets the keyboard back.
        if !NSApp.windows.contains(where: { $0.isVisible && $0.canBecomeKey }) { NSApp.hide(nil) }
        update()
    }

    private func addItem() {
        guard item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        guard let button = item.button else { return }
        button.image = Self.arch
        button.target = self
        button.action = #selector(clicked)
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        let dot = MenuBarDot(frame: .zero)
        dot.isHidden = true
        button.addSubview(dot)
        self.item = item
        self.dot = dot
        watch = NewCastWatch()
        checks = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { return }
                await self?.state?.model?.refreshIfOlder(than: Self.checkEvery)
            }
        }
    }

    private func removeItem() {
        guard let item else { return }
        checks?.cancel()
        checks = nil
        NSStatusBar.system.removeStatusItem(item)
        self.item = nil
        dot = nil
        // Without the icon there'd be no way back to a hidden window.
        if feedWindow?.isVisible == false { showFeed() }
    }

    private var feedInFront: Bool {
        guard let window = feedWindow else { return false }
        return NSApp.isActive && window.isVisible && !window.isMiniaturized
    }

    private func update() {
        installCloser()
        guard let button = item?.button, let dot else { return }
        var shows = watch.showsDot(newest: state?.model?.newestFromOthers, inFront: feedInFront)
        #if DEBUG
        // `-FatlineMenuBarDot YES` shows the dot without waiting for someone to post.
        if UserDefaults.standard.bool(forKey: "FatlineMenuBarDot") { shows = true }
        #endif
        let size: CGFloat = 6
        dot.frame = NSRect(x: button.bounds.midX + 5, y: button.bounds.midY - 10, width: size, height: size)
        dot.isHidden = !shows
        button.setAccessibilityLabel(shows ? "Fatline, new casts" : "Fatline")
    }

    @objc private func windowsChanged() { update() }

    /// Runs `update` whenever the newest cast changes, for as long as the app runs.
    private func watchFeed() {
        withObservationTracking {
            _ = state?.model?.newestFromOthers
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.update()
                self?.watchFeed()
            }
        }
    }

    /// SwiftUI owns the feed window, so this stands in front of its delegate to turn a close into a hide.
    private func installCloser() {
        guard let window = feedWindow, closer == nil || window.delegate !== closer else { return }
        let closer = FeedWindowCloser(original: window.delegate) { [weak self] in
            guard let self, self.state?.showsMenuBarIcon == true else { return false }
            self.hideFeed()
            return true
        }
        self.closer = closer
        window.delegate = closer
    }

    @objc private func clicked() {
        let event = NSApp.currentEvent
        let wantsMenu = event?.type == .rightMouseUp
            || event?.modifierFlags.intersection([.option, .control]).isEmpty == false
        if wantsMenu {
            showMenu()
        } else if let window = feedWindow, window.isKeyWindow, NSApp.isActive {
            hideFeed()
        } else {
            showFeed()
        }
    }

    private func showMenu() {
        guard let item, let state else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        let signedIn = state.session.account?.fid != nil
        let composing = state.session.showComposer
        add("New Cast", "n", #selector(newCast), to: menu, enabled: signedIn && !composing)
        add("Refresh", "r", #selector(refresh), to: menu, enabled: state.model != nil && !composing)
        menu.addItem(.separator())
        add("Settings…", ",", #selector(settings), to: menu, enabled: state.model != nil)
        menu.addItem(.separator())
        add("Quit Fatline", "q", #selector(quit), to: menu, enabled: true)
        // A menu left on the item would take over the plain click too.
        item.menu = menu
        item.button?.performClick(nil)
        item.menu = nil
    }

    private func add(_ title: String, _ key: String, _ action: Selector, to menu: NSMenu, enabled: Bool) {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        entry.isEnabled = enabled
        menu.addItem(entry)
    }

    @objc private func newCast() {
        showFeed()
        state?.session.openComposer()
    }

    @objc private func refresh() {
        guard let model = state?.model else { return }
        Task { await model.refresh(reason: "pull") }
    }

    @objc private func settings() {
        NSApp.activate()
        openWindow?(id: "settings")
    }

    @objc private func quit() { NSApp.terminate(nil) }

    /// The app icon's arch as one flat shape, so the menu bar can tint it.
    private static let arch: NSImage = {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
            let path = NSBezierPath()
            path.move(to: NSPoint(x: 30, y: 96))
            path.line(to: NSPoint(x: 30, y: 59))
            path.appendArc(withCenter: NSPoint(x: 64, y: 59), radius: 34, startAngle: 180, endAngle: 360)
            path.line(to: NSPoint(x: 98, y: 96))
            path.close()
            path.move(to: NSPoint(x: 39, y: 87))
            path.line(to: NSPoint(x: 89, y: 87))
            path.line(to: NSPoint(x: 89, y: 59))
            path.appendArc(withCenter: NSPoint(x: 64, y: 59), radius: 25, startAngle: 360, endAngle: 180, clockwise: true)
            path.close()
            path.windingRule = .evenOdd
            let scale: CGFloat = 15 / 74
            var transform = AffineTransform(translationByX: 9 - 64 * scale, byY: 9 - 59 * scale)
            transform.scale(scale)
            path.transform(using: transform)
            NSColor.black.setFill()
            path.fill()
            return true
        }
        image.isTemplate = true
        return image
    }()
}

/// The gold of the app icon's sun, a little deeper on a light menu bar so it still shows.
private final class MenuBarDot: NSView {
    override func draw(_ dirtyRect: NSRect) {
        let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        (dark ? NSColor(srgbRed: 0.83, green: 0.69, blue: 0.22, alpha: 1)
              : NSColor(srgbRed: 0.78, green: 0.60, blue: 0.12, alpha: 1)).setFill()
        NSBezierPath(ovalIn: bounds).fill()
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Passes everything to the window's own delegate, except the question of whether to close.
private final class FeedWindowCloser: NSObject, NSWindowDelegate {
    private weak var original: (any NSWindowDelegate)?
    private let hide: @MainActor () -> Bool

    init(original: (any NSWindowDelegate)?, hide: @escaping @MainActor () -> Bool) {
        self.original = original
        self.hide = hide
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || original?.responds(to: selector) == true
    }

    override func forwardingTarget(for selector: Selector!) -> Any? { original }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if hide() { return false }
        return original?.windowShouldClose?(sender) ?? true
    }
}

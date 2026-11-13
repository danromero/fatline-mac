import AppKit
import SwiftUI

// Native menus where SwiftUI's can't do enough: a menu item can't carry a dot in the check column, a
// bold title, or a picture SwiftUI drew, and a context menu can't tell its row it's open.

/// A menu item that runs a closure.
final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, key: String = "", modifiers: NSEvent.ModifierFlags = .command, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: key)
        target = self
        keyEquivalentModifierMask = modifiers
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("Not used from a nib") }

    @objc private func fire() { handler() }
}

extension NSMenu {
    /// A menu that leaves items enabled as they're made, rather than asking a responder chain, and
    /// shows the pictures items were given.
    static func plain(_ items: [NSMenuItem]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for item in items {
            // Newer systems hide a menu item's picture unless the item asks to show it.
            if item.image != nil { item.preferredImageVisibility = .visible }
            menu.addItem(item)
        }
        return menu
    }
}

/// Where a SwiftUI button pops a menu from: an invisible view behind the button.
@MainActor
final class MenuAnchor {
    fileprivate weak var view: NSView?

    /// Pops the menu just below the anchor, lined up with its leading edge, and returns once it closes.
    func popUp(_ menu: NSMenu) {
        guard let view else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: view.bounds.height + Self.drop), in: view)
    }

    /// The gap between the button and the menu, as in a toolbar's own menus.
    private static let drop: CGFloat = 4 // layout-ok: matches AppKit toolbar menus
}

struct MenuAnchorView: NSViewRepresentable {
    let anchor: MenuAnchor

    func makeNSView(context: Context) -> NSView {
        let view = FlippedView()
        anchor.view = view
        return view
    }

    func updateNSView(_ view: NSView, context: Context) { anchor.view = view }

    private final class FlippedView: NSView {
        override var isFlipped: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

extension View {
    /// A right-click menu built when it opens, with `open` true while it shows, so the row can stay
    /// highlighted the way a Mac list's row does.
    func rightClickMenu(open: Binding<Bool>, _ makeMenu: @escaping () -> NSMenu) -> some View {
        overlay(RightClickCatcher(open: open, makeMenu: makeMenu))
    }
}

private struct RightClickCatcher: NSViewRepresentable {
    @Binding var open: Bool
    let makeMenu: () -> NSMenu

    func makeNSView(context: Context) -> CatcherView { CatcherView() }

    func updateNSView(_ view: CatcherView, context: Context) {
        view.makeMenu = makeMenu
        view.setOpen = { open = $0 }
    }

    final class CatcherView: NSView {
        var makeMenu: (() -> NSMenu)?
        var setOpen: ((Bool) -> Void)?

        /// Only right clicks and Control-clicks stop here. Everything else goes to the row beneath.
        override func hitTest(_ point: NSPoint) -> NSView? {
            guard let event = NSApp.currentEvent else { return nil }
            switch event.type {
            case .rightMouseDown, .rightMouseUp: return super.hitTest(point)
            case .leftMouseDown where event.modifierFlags.contains(.control): return super.hitTest(point)
            default: return nil
            }
        }

        override func rightMouseDown(with event: NSEvent) { show(event) }

        override func mouseDown(with event: NSEvent) {
            if event.modifierFlags.contains(.control) { show(event) } else { super.mouseDown(with: event) }
        }

        private func show(_ event: NSEvent) {
            guard let menu = makeMenu?() else { return }
            setOpen?(true)
            NSMenu.popUpContextMenu(menu, with: event, for: self)
            setOpen?(false)
        }
    }
}

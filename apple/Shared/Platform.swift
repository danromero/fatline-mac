import SwiftUI

/// What differs between the iPhone and Mac apps, so shared code can stay the same for both.
enum Platform {
    #if os(macOS)
    /// Used in messages such as "This Mac's posting key".
    static let deviceName = "Mac"
    static let systemName = "macOS"
    /// Used in instructions such as "Click to check."
    static let pressVerb = "Click"
    /// What cast pictures may use in memory and on disk.
    static let imageMemoryLimit = 300_000_000
    static let imageDiskLimit = 300_000_000
    #else
    static let deviceName = "iPhone"
    static let systemName = "iOS"
    static let pressVerb = "Tap"
    /// What cast pictures may use in memory and on disk.
    static let imageMemoryLimit = 100_000_000
    static let imageDiskLimit = 150_000_000
    #endif

    /// Where this app keeps its drafts and feed. A Mac app with no sandbox shares Application Support
    /// with every other build, so Fatline and Fatline Dev each need their own folder there.
    static var appFolder: URL {
        #if os(macOS)
        URL.applicationSupportDirectory.appending(path: Bundle.main.bundleIdentifier ?? "Fatline")
        #else
        URL.applicationSupportDirectory.appending(path: "Fatline")
        #endif
    }

    @MainActor
    static var reduceMotion: Bool {
        #if os(macOS)
        NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        #else
        UIAccessibility.isReduceMotionEnabled
        #endif
    }

    @MainActor
    static func copyToClipboard(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }

    @MainActor
    static func announce(_ message: String) {
        AccessibilityNotification.Announcement(message).post()
    }

    enum Haptic {
        /// A deliberate press: the plus, Post, or a copy that has nothing on screen to confirm it.
        case tap
        /// Choosing between options.
        case pick
        /// Something finished, such as Sent.
        case done
        /// Something didn't work. The one haptic strong enough to notice with your eyes elsewhere.
        case problem
    }

    /// The app's only haptics, kept gentle on purpose. A Mac has none.
    @MainActor
    static func haptic(_ haptic: Haptic) {
        #if os(iOS)
        switch haptic {
        case .tap: UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.7)
        case .pick: UISelectionFeedbackGenerator().selectionChanged()
        case .done: UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.8)
        case .problem: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
        #endif
    }
}

import Foundation
import Observation

/// Offers each newer TestFlight build once, like the Mac's update check offers each release.
@MainActor @Observable
final class BuildCheck {
    private(set) var offered: BuildFeed?
    let current = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    private var lastCheck = Date.distantPast
    private static let announcedKey = "announcedBuild"

    /// Called at launch and whenever the app comes forward, because people leave it open for days.
    func runIfDue() async {
        // Tests launch the app, and an alert would stop them.
        #if !DEBUG
        guard let address = Bundle.main.object(forInfoDictionaryKey: "FatlineBuildFeed") as? String,
              let feed = URL(string: address), feed.scheme == "https",
              Date.now.timeIntervalSince(lastCheck) >= 24 * 60 * 60
        else { return }
        lastCheck = .now
        let request = URLRequest(url: feed, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let offer = BuildFeed.offer(data, current: current, announced: UserDefaults.standard.integer(forKey: Self.announcedKey))
        else { return }
        UserDefaults.standard.set(offer.build, forKey: Self.announcedKey)
        offered = offer
        #endif
    }

    func dismiss() { offered = nil }
}

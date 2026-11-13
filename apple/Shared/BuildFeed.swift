import Foundation

/// The newest TestFlight build Friends can install, as `FatlineBuildFeed` in Info.plist serves it.
/// Only TestFlight.xcconfig sets that address, so open source and development builds never ask.
struct BuildFeed: Decodable, Equatable {
    let build: Int
    let link: URL

    /// The feed's build when it's newer than this one and hasn't been offered before. The link has to
    /// be TestFlight's, because the alert sends people there.
    static func offer(_ data: Data, current: Int, announced: Int) -> BuildFeed? {
        guard let feed = try? JSONDecoder().decode(BuildFeed.self, from: data),
              feed.build > max(current, announced),
              feed.link.scheme == "https", feed.link.host() == "testflight.apple.com"
        else { return nil }
        return feed
    }
}

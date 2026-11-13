import CryptoKit
import Foundation

/// The Fatline networks this device belongs to, and the one being looked at. Farcaster is the
/// default, shown when no network is selected.
@MainActor
@Observable
final class NetworkModel {
    private static let selectedKey = "selectedNetwork" + DevProfile.suffix
    private static let seenPostsKey = "networkSeenPosts" + DevProfile.suffix
    private static let seenActivityKey = "networkSeenActivity" + DevProfile.suffix
    static let pollInterval: TimeInterval = 60

    private(set) var device: NetworkDevice?
    private(set) var memberships: [NetworkMembership] = []
    /// Nil means Farcaster.
    private(set) var selectedHost: String?

    // The selected network's feed.
    private(set) var posts: [NetworkPost] = []
    private(set) var members: [NetworkMember] = []
    private(set) var loading = false
    private(set) var problem: String?
    private(set) var lastRead: Date?
    /// You, as the selected network knows you.
    private(set) var you: NetworkMember?
    var toast: String?

    // What's new, by host: the newest post by someone else and the newest activity, against the
    // newest of each that was on screen. Seen times are kept, so a dot survives quitting.
    private var newestPost: [String: Int64] = [:]
    private var newestActivity: [String: Int64] = [:]
    private var seenPosts: [String: Int64] = UserDefaults.standard.dictionary(forKey: seenPostsKey) as? [String: Int64] ?? [:]
    private var seenActivity: [String: Int64] = UserDefaults.standard.dictionary(forKey: seenActivityKey) as? [String: Int64] ?? [:]

    init() {
        #if DEBUG
        // `-FatlineForgetNetworks YES` starts with no networks and no device key, for testing.
        if UserDefaults.standard.bool(forKey: "FatlineForgetNetworks") {
            Self.forgetAll()
            seenPosts = [:]
            seenActivity = [:]
        }
        #endif
        device = try? NetworkKeychain.device.load()
        #if DEBUG
        // `-FatlineDeviceKeyFile path` uses a made-up account's key from `npm run demo`, in place of its phrase.
        if device == nil, let path = UserDefaults.standard.string(forKey: "FatlineDeviceKeyFile"), let loaded = Self.demoDevice(path) {
            try? NetworkKeychain.device.save(loaded)
            device = loaded
        }
        #endif
        memberships = (try? NetworkKeychain.memberships.load()) ?? []
        let saved = UserDefaults.standard.string(forKey: Self.selectedKey)
        selectedHost = memberships.contains { $0.host == saved } ? saved : nil
    }

    var selected: NetworkMembership? { memberships.first { $0.host == selectedHost } }

    #if DEBUG
    /// The device part of a key file the network folder's scripts write.
    private static func demoDevice(_ path: String) -> NetworkDevice? {
        struct KeyFile: Decodable {
            struct Device: Decodable { let secret: String; let issuedAt: Int64; let signature: String }
            let fid: UInt64
            let custody: String
            let device: Device
        }
        guard let data = FileManager.default.contents(atPath: path),
              let file = try? JSONDecoder().decode(KeyFile.self, from: data),
              let key = Data(hex: file.device.secret)
        else { return nil }
        return NetworkDevice(fid: file.fid, custody: file.custody.lowercased(), key: key,
                             issuedAt: file.device.issuedAt, signature: file.device.signature)
    }
    #endif

    func select(_ host: String?) {
        guard host != selectedHost else { return }
        selectedHost = host
        UserDefaults.standard.set(host, forKey: Self.selectedKey)
        posts = []
        members = []
        you = nil
        problem = nil
        lastRead = nil
    }

    // MARK: What's new

    /// Replies to you and mentions of you that the selected network has and Activity hasn't shown.
    var hasNewActivity: Bool {
        guard let host = selectedHost else { return false }
        return (newestActivity[host] ?? 0) > (seenActivity[host] ?? .max)
    }

    /// New posts or activity in a network that isn't showing.
    func hasNews(_ host: String) -> Bool {
        guard host != selectedHost else { return false }
        return (newestPost[host] ?? 0) > (seenPosts[host] ?? .max) || (newestActivity[host] ?? 0) > (seenActivity[host] ?? .max)
    }

    /// Whether any network other than the one showing has something new.
    var othersHaveNews: Bool { memberships.contains { $0.status == .approved && hasNews($0.host) } }

    func markActivitySeen() {
        guard let host = selectedHost, let newest = newestActivity[host] else { return }
        seenActivity[host] = newest
        UserDefaults.standard.set(seenActivity, forKey: Self.seenActivityKey)
    }

    /// Records what a network has. The first look at a network counts as seen, so joining shows no dots.
    private func note(_ host: String, posts: [NetworkPost], activity: [NetworkActivity.Item], fid: UInt64) {
        let newestPost = posts.first { $0.fid != fid }?.time ?? 0
        let newestActivity = activity.first?.post.time ?? 0
        self.newestPost[host] = newestPost
        self.newestActivity[host] = newestActivity
        if host == selectedHost || seenPosts[host] == nil { seenPosts[host] = max(newestPost, posts.first?.time ?? 0) }
        if seenActivity[host] == nil { seenActivity[host] = newestActivity }
        UserDefaults.standard.set(seenPosts, forKey: Self.seenPostsKey)
        UserDefaults.standard.set(seenActivity, forKey: Self.seenActivityKey)
    }

    /// Looks for news in the networks that aren't showing.
    func checkOthers() async {
        for membership in memberships where membership.status == .approved && membership.host != selectedHost {
            guard let (feed, activity) = try? await signedIn(membership.host, { client in
                async let feed = client.feed()
                async let activity = client.activity()
                return try await (feed, activity)
            }) else { continue }
            note(membership.host, posts: feed, activity: activity, fid: membership.fid)
        }
    }

    // MARK: Joining

    /// True until this device has a key, which the recovery phrase approves once.
    var needsPhrase: Bool { device == nil }

    /// Approves a key for this device with the recovery phrase, which isn't kept.
    func approveDevice(phrase: String) async throws {
        let signer = try RecoverySigner(phrase: phrase)
        guard let fid = try await Optimism.fid(owning: signer.address) else {
            throw NetworkError.server(status: 0, message: "No Farcaster account belongs to that recovery phrase.")
        }
        let key = Curve25519.Signing.PrivateKey()
        let issuedAt = Int64(Date.now.timeIntervalSince1970)
        let signature = try signer.approveDevice(fid: fid, key: key, issuedAt: issuedAt)
        let device = NetworkDevice(fid: fid, custody: signer.address.lowercased(), key: key.rawRepresentation,
                                   issuedAt: issuedAt, signature: signature)
        try NetworkKeychain.device.save(device)
        self.device = device
    }

    /// What joining a network came to, for the screen after it.
    struct JoinResult: Hashable, Sendable {
        let host: String
        let status: NetworkMembership.Status
        var name: String?
        var icon: String?
        var memberCount: Int?
    }

    /// Joins with an address or a `CODE@host` invite. Once in, it reads the network's name and size.
    /// `avatar` is this account's Farcaster picture, when the app knows it, for the network to copy.
    func join(typed: String, avatar: String? = nil) async throws -> JoinResult {
        guard let device else { throw NetworkError.notSignedIn }
        let (host, invite) = Self.parse(typed)
        guard let host else { throw NetworkError.server(status: 0, message: "Use the format server.example or CODE@server.example.") }
        var membership = try await NetworkClient.join(host: host, device: device, invite: invite, avatar: avatar)
        if membership.status == .approved { membership = try await NetworkClient(membership: membership).signIn() }
        var result = JoinResult(host: host, status: membership.status)
        if membership.status == .approved {
            let client = NetworkClient(membership: membership)
            if let info = try? await client.info() {
                let name = NetworkMembership.acceptedName(info.name, host: host, others: memberships)
                membership.name = name
                membership.isAdmin = info.you.role == "admin"
                membership.icon = info.icon
                result.name = name
                result.icon = info.icon
            }
            result.memberCount = try? await client.members().count
        }
        try add(membership)
        return result
    }

    /// For a network that's waiting on the admin: asks whether they've decided.
    func checkAgain(_ host: String) async {
        guard let membership = memberships.first(where: { $0.host == host }) else { return }
        do {
            let updated = try await NetworkClient(membership: membership).signIn()
            guard try update(updated) else { return }
            if updated.status == .approved { await refresh() }
        } catch {
            problem = error.localizedDescription
        }
    }

    #if DEBUG
    /// `-FatlineJoin "CODE@host,host"` joins those networks at launch, for trying a build with a demo
    /// network's key file before it has a way to add one.
    func joinFromLaunch() async {
        guard let list = UserDefaults.standard.string(forKey: "FatlineJoin") else { return }
        for typed in list.split(separator: ",").map(String.init) {
            guard let host = Self.parse(typed).host, !memberships.contains(where: { $0.host == host }) else { continue }
            _ = try? await join(typed: typed)
        }
    }
    #endif

    /// Takes the address and code from `CODE@host`, or just the address.
    static func parse(_ typed: String) -> (host: String?, invite: String?) {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        let codeCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        if let at = text.lastIndex(of: "@"), !text.hasPrefix("http") {
            let code = String(text[..<at])
            guard (1...128).contains(code.count), code.allSatisfy(codeCharacters.contains) else { return (nil, nil) }
            return (NetworkMessages.host(from: String(text[text.index(after: at)...])), code)
        }
        return (NetworkMessages.host(from: text), nil)
    }

    // MARK: Reading

    var isStale: Bool { lastRead.map { Date.now.timeIntervalSince($0) > Self.pollInterval } ?? true }

    func refresh() async {
        guard let host = selectedHost, selected?.status == .approved, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let (feed, members, info, activity) = try await signedIn(host) { client in
                async let feed = client.feed()
                async let members = client.members()
                async let info = client.info()
                async let activity = client.activity()
                return try await (feed, members, info, activity)
            }
            guard host == selectedHost else { return }
            posts = feed
            self.members = members
            you = info.you
            lastRead = .now
            problem = nil
            note(host, posts: feed, activity: activity, fid: info.you.fid)
            let name = NetworkMembership.acceptedName(info.name, host: host, others: memberships)
            if var membership = selected,
               membership.name != name || membership.isAdmin != (info.you.role == "admin") || membership.icon != info.icon {
                membership.name = name
                membership.isAdmin = info.you.role == "admin"
                membership.icon = info.icon
                _ = try? update(membership)
            }
        } catch {
            guard host == selectedHost else { return }
            problem = error.localizedDescription
        }
    }

    func thread(_ hash: String) async throws -> (post: NetworkPost, replies: [NetworkPost]) {
        try await signedIn { try await $0.thread(hash) }
    }

    func activity() async throws -> [NetworkActivity.Item] {
        let items = try await signedIn { try await $0.activity() }
        if let host = selectedHost, let newest = items.first?.post.time {
            newestActivity[host] = max(newestActivity[host] ?? 0, newest)
        }
        markActivitySeen()
        return items
    }

    /// How a member shows: @username, or !fid without one.
    func handle(for fid: UInt64) -> String {
        members.first { $0.fid == fid }?.handle ?? "!\(fid)"
    }

    var ownFID: UInt64? { selected?.fid }

    /// A post in the shape the feed's rows take.
    func cast(for post: NetworkPost) -> FeedCast {
        // A link with a preview shows as a card, and one already in the text is a link there, so
        // neither shows again as a line under the text.
        let text = post.text.lowercased()
        let links = post.embeds.compactMap { $0.type == "link" && $0.preview == nil ? $0.url : nil }.filter { url in
            let bare = url.replacingOccurrences(of: #"^https?://(www\.)?"#, with: "", options: .regularExpression).lowercased()
            return !text.contains(url.lowercased()) && !text.contains(bare)
        }
        let quote = post.embeds.first { $0.type == "post" }?.post.map {
            FeedCast.Quote(fid: $0.fid, handle: handle(for: $0.fid), text: $0.text)
        }
        let images = post.embeds.compactMap { $0.type == "image" ? $0.src : nil }
        return FeedCast(hash: post.hash, fid: post.fid, time: post.time, text: post.text,
                        links: links.isEmpty ? nil : links, quote: quote,
                        avatar: members.first { $0.fid == post.fid }?.avatar,
                        images: images.isEmpty ? nil : images, mediaHost: selectedHost)
    }

    /// A link the network has read, for a card under the post.
    struct LinkCard: Identifiable, Hashable {
        let url: URL
        let title: String?
        let description: String?
        /// The page's picture, from the network's own host.
        let image: URL?

        var id: URL { url }
    }

    /// The post's links that have a title, description, or picture. Only HTTPS links open.
    func linkCards(for post: NetworkPost) -> [LinkCard] {
        post.embeds.compactMap { embed in
            guard embed.type == "link", let preview = embed.preview, let link = embed.url,
                  let url = URL(string: link), url.scheme == "https", url.host() != nil else { return nil }
            let image = preview.image.flatMap { image in selectedHost.flatMap { FeedCast.networkMediaURL(image, host: $0) } }
            guard preview.title != nil || preview.description != nil || image != nil else { return nil }
            return LinkCard(url: url, title: preview.title, description: preview.description, image: image)
        }
    }

    // MARK: Changing

    /// Posts, or replies when `parent` is set, to `host`, the network the composer opened on. Pictures
    /// go up first, then the post with up to two attachments, pictures before the link. Returns once the
    /// network has it. If another network is showing by now, nothing is sent and the draft stays, since
    /// its mentions name the members of the network it was written for.
    func post(to host: String, text: String, link: String? = nil, images: [NetworkImage] = [], parent: NetworkPost? = nil) async throws {
        guard let membership = memberships.first(where: { $0.host == host }) else { throw NetworkError.notSignedIn }
        guard host == selectedHost else {
            throw NetworkError.server(status: 0, message: "This post is for \(membership.title). Switch back to it to post.")
        }
        let handles = Dictionary(members.map { ($0.username.lowercased(), $0.fid) }, uniquingKeysWith: { first, _ in first })
        var embeds: [NetworkMessages.Embed] = []
        for image in images.prefix(NetworkMessages.maxEmbeds) {
            let (data, type) = (image.data, image.type)
            let uploaded = try await signedIn(membership.host) { try await $0.upload(data, type: type) }
            embeds.append(.link(uploaded.url))
        }
        if let link, embeds.count < NetworkMessages.maxEmbeds { embeds.append(.link(link)) }
        let message = try NetworkMessages.post(fid: membership.fid, text: text, handles: handles, embeds: embeds,
                                               parent: parent.map { ($0.fid, $0.hash) }, key: membership.signingKey)
        // The network it was signed for, even if another was chosen while pictures went up.
        try await signedIn(membership.host) { try await $0.submit(message) }
        toast = parent == nil ? "Sent" : "Replied"
        // The post is in. The composer closes now, and the feed catches up behind it.
        Task { await refresh() }
    }

    func toggleLike(_ post: NetworkPost) async {
        guard let membership = selected else { return }
        do {
            let message = try NetworkMessages.like(!post.liked, fid: membership.fid, target: (post.fid, post.hash), key: membership.signingKey)
            try await signedIn(membership.host) { try await $0.submit(message) }
            await refresh()
        } catch {
            problem = error.localizedDescription
        }
    }

    func delete(_ post: NetworkPost) async throws {
        guard let membership = selected else { return }
        let message = try NetworkMessages.removal(fid: membership.fid, target: post.hash, key: membership.signingKey)
        try await signedIn(membership.host) { try await $0.submit(message) }
        toast = "Deleted"
        await refresh()
    }

    func adminLink() async throws -> URL {
        try await signedIn { try await $0.adminLink() }
    }

    func waitingRequests() async throws -> Int {
        try await signedIn { try await $0.waitingRequests() }
    }

    func setMuted(_ fid: UInt64, _ muted: Bool) async throws {
        try await signedIn { try await $0.mute(fid, muted) }
        toast = "\(muted ? "Muted" : "Unmuted") \(handle(for: fid))"
        await refresh()
    }

    func isMuted(_ fid: UInt64) -> Bool { members.first { $0.fid == fid }?.muted ?? false }

    func report(_ post: NetworkPost, note: String) async throws {
        try await signedIn { try await $0.report(post.hash, note: note) }
        toast = "Reported"
    }

    func updateProfile(displayName: String, bio: String) async throws {
        you = try await signedIn { try await $0.updateProfile(displayName: displayName, bio: bio) }
        await refresh()
    }

    /// Uploads a picture for this network only, or with nil goes back to the Farcaster one.
    func setAvatar(_ image: NetworkImage?) async throws {
        guard let host = selectedHost else { return }
        let avatar: String
        if let image {
            let (data, type) = (image.data, image.type)
            avatar = try await signedIn(host) { try await $0.upload(data, type: type) }.id
        } else {
            avatar = "farcaster"
        }
        you = try await signedIn(host) { try await $0.setAvatar(avatar) }
        await refresh()
    }

    /// The address that opens a post, for sharing with other members.
    func link(for post: NetworkPost) -> URL? {
        guard let host = selectedHost else { return nil }
        return NetworkMessages.origin(host).appending(path: "p/\(post.hash)")
    }

    func leave() async throws {
        guard let membership = selected else { return }
        try await signedIn(membership.host) { try await $0.leave() }
        // Leaving ended every session there already.
        remove(membership.host)
    }

    /// Forgets every network and this device's key, so the next network asks for a recovery phrase,
    /// perhaps another account's. Each network's session ends, but the networks still list this
    /// device until someone leaves them.
    func forgetEverything() {
        Self.endSessions(memberships)
        Self.forgetAll()
        device = nil
        memberships = []
        forgetSeen()
        select(nil)
    }

    private static func forgetAll() {
        try? NetworkKeychain.memberships.remove()
        try? NetworkKeychain.device.remove()
        for key in [selectedKey, seenPostsKey, seenActivityKey] { UserDefaults.standard.removeObject(forKey: key) }
    }

    /// What was seen in one network, or in all of them, so joining again shows no dots, as joining does.
    private func forgetSeen(_ host: String? = nil) {
        for keyPath in [\NetworkModel.newestPost, \.newestActivity, \.seenPosts, \.seenActivity] {
            if let host { self[keyPath: keyPath][host] = nil } else { self[keyPath: keyPath] = [:] }
        }
        UserDefaults.standard.set(seenPosts, forKey: Self.seenPostsKey)
        UserDefaults.standard.set(seenActivity, forKey: Self.seenActivityKey)
    }

    /// Takes a network off this device, for one that refused or is gone. Its session ends, but the
    /// network still lists this device.
    func forget(_ host: String) {
        Self.endSessions(memberships.filter { $0.host == host })
        remove(host)
    }

    private func remove(_ host: String) {
        memberships.removeAll { $0.host == host }
        try? NetworkKeychain.memberships.save(memberships)
        forgetSeen(host)
        if selectedHost == host { select(nil) }
    }

    /// Ends these memberships' sessions on their networks, without waiting and whatever the answer,
    /// since they're being forgotten anyway. The tokens stop working even if a copy of one survives.
    private static func endSessions(_ ending: [NetworkMembership]) {
        for membership in ending where membership.token != nil {
            Task { try? await NetworkClient(membership: membership).endSession() }
        }
    }

    // MARK: Plumbing

    /// Adds a membership, or replaces one for the same host. Only joining adds.
    private func add(_ membership: NetworkMembership) throws {
        if let index = memberships.firstIndex(where: { $0.host == membership.host }) {
            memberships[index] = membership
        } else {
            memberships.append(membership)
        }
        try NetworkKeychain.memberships.save(memberships)
    }

    /// Saves a change to a membership in place. Returns false, saving nothing, if it was forgotten while
    /// a request was under way, or forgotten and joined again with a new key, so it stays forgotten.
    @discardableResult
    private func update(_ membership: NetworkMembership) throws -> Bool {
        guard let index = memberships.firstIndex(where: { $0.host == membership.host && $0.key == membership.key }) else { return false }
        memberships[index] = membership
        try NetworkKeychain.memberships.save(memberships)
        return true
    }

    /// Runs `work` signed in to a network, the selected one unless another is named, signing in
    /// again once if the session ended.
    private func signedIn<Result: Sendable>(_ host: String? = nil, _ work: @Sendable (NetworkClient) async throws -> Result) async throws -> Result {
        guard var membership = memberships.first(where: { $0.host == (host ?? selectedHost) }) else { throw NetworkError.notSignedIn }
        if membership.token == nil || (membership.expires ?? 0) < Int64(Date.now.timeIntervalSince1970) + 60 {
            membership = try await NetworkClient(membership: membership).signIn()
            guard try update(membership) else { throw NetworkError.notSignedIn }
        }
        guard membership.status == .approved else { throw membership.status == .refused ? NetworkError.refused : NetworkError.notSignedIn }
        do {
            return try await work(NetworkClient(membership: membership))
        } catch NetworkError.notSignedIn {
            membership = try await NetworkClient(membership: membership).signIn()
            guard try update(membership) else { throw NetworkError.notSignedIn }
            guard membership.status == .approved else { throw NetworkError.refused }
            return try await work(NetworkClient(membership: membership))
        }
    }
}

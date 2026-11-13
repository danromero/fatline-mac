import CryptoKit
import Foundation

/// This device's key for Fatline networks, approved once by the account's custody address.
struct NetworkDevice: Codable, Sendable {
    let fid: UInt64
    let custody: String
    let key: Data
    let issuedAt: Int64
    let signature: String

    var signingKey: Curve25519.Signing.PrivateKey {
        get throws { try Curve25519.Signing.PrivateKey(rawRepresentation: key) }
    }
}

/// One network this device has joined or asked to join.
struct NetworkMembership: Codable, Hashable, Identifiable, Sendable {
    enum Status: String, Codable, Sendable { case approved, pending, refused }

    let host: String
    let fid: UInt64
    let key: Data
    let issued: Int64
    let approval: String
    var status: Status
    var token: String?
    var expires: Int64?
    var name: String?
    var isAdmin = false
    /// A link to the network's picture, or nil for its first letter.
    var icon: String?

    var id: String { host }
    var title: String { name ?? host }
    /// The name with the host beside it, for menus and Settings, so a network can't pass for another.
    var label: String { name.map { "\($0) · \(host)" } ?? host }

    /// The name a network gives itself, if the app shows it: at most 64 characters, nothing hidden or
    /// reversed, and not "Farcaster", an address, or another network's name or address, so one
    /// network can't pass for another. Otherwise the app shows the host.
    static func acceptedName(_ given: String?, host: String, others: [NetworkMembership]) -> String? {
        guard let name = given?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty, name.count <= 64,
              !name.unicodeScalars.contains(where: hides) else { return nil }
        // Something like "net.example.com" reads as an address.
        if !name.contains(" "), name.contains("."), name.lowercased() != host { return nil }
        let fold = { (text: String) in text.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil) }
        let taken = ["Farcaster", "Fatline"] + others.filter { $0.host != host }.flatMap { [$0.title, $0.host] }
        return taken.contains { fold($0) == fold(name) } ? nil : name
    }

    /// Characters that show as nothing or reorder text: controls, format characters, and Hangul
    /// fillers. The zero-width joiner and non-joiner, and emoji tags, stay.
    private static func hides(_ scalar: Unicode.Scalar) -> Bool {
        if scalar.value == 0x200C || scalar.value == 0x200D || (0xE0020...0xE007F).contains(scalar.value) { return false }
        switch scalar.properties.generalCategory {
        case .control, .format: return true
        default: return [0x115F, 0x1160, 0x3164, 0xFFA0].contains(scalar.value)
        }
    }

    var signingKey: Curve25519.Signing.PrivateKey {
        get throws { try Curve25519.Signing.PrivateKey(rawRepresentation: key) }
    }
}

enum NetworkKeychain {
    static let device = KeychainValue<NetworkDevice>(account: "network-device-v1")
    static let memberships = KeychainValue<[NetworkMembership]>(account: "network-memberships-v1")
}

/// What a network server answers. See docs/NETWORK.md.
struct NetworkPost: Codable, Hashable, Identifiable, Sendable {
    struct Mention: Codable, Hashable, Sendable {
        let fid: UInt64
        let username: String
    }

    struct Quoted: Codable, Hashable, Sendable {
        let hash: String
        let fid: UInt64
        let text: String
    }

    struct Embed: Codable, Hashable, Sendable {
        struct Preview: Codable, Hashable, Sendable {
            var title: String?
            var description: String?
            var image: String?
        }

        let type: String
        var url: String?
        var hash: String?
        var post: Quoted?
        // An image: its size, and signed links to its display size and the file itself.
        var width: Int?
        var height: Int?
        var src: String?
        var full: String?
        /// A link: what the network read from the page, once it has.
        var preview: Preview?
    }

    let hash: String
    let fid: UInt64
    let time: Int64
    let text: String
    let mentions: [Mention]
    let parent: String?
    let embeds: [Embed]
    let replies: Int
    let likes: Int
    let liked: Bool
    let deleted: Bool

    var id: String { hash }
}

struct NetworkMember: Codable, Hashable, Identifiable, Sendable {
    let fid: UInt64
    let username: String
    let displayName: String
    let bio: String
    let role: String
    let joined: Int64
    let muted: Bool
    /// A signed link to their picture's thumb size.
    var avatar: String?
    /// Whether the picture was uploaded to this network, rather than copied from Farcaster.
    var ownAvatar: Bool?

    var id: UInt64 { fid }
    var handle: String { username.hasPrefix("!") ? username : "@\(username)" }
}

struct NetworkInfo: Codable, Sendable {
    let name: String
    /// A link to the network's picture, which changes with it, or nil.
    var icon: String?
    let retention: String
    let you: NetworkMember
}

struct NetworkActivity: Codable, Sendable {
    struct Item: Codable, Hashable, Sendable {
        let kind: String
        let post: NetworkPost
        /// For a reply, the post it answers.
        var parent: NetworkPost?

        /// The post whose replies this item belongs with: the answered post for a reply.
        var threadRoot: NetworkPost { parent ?? post }
    }

    let items: [Item]
}

/// The most an honest network sends, from docs/NETWORK.md, checked as each answer arrives. A post
/// or member past them is dropped and lists are cut short, so a server can't have the app lay out
/// megabytes of text or start thousands of downloads.
enum NetworkLimits {
    static let textBytes = 1024
    static let mentions = 10
    static let linkBytes = 256
    /// Signed picture links and the network's icon, which run longer than links in posts.
    static let addressBytes = 2048
    /// Previews are 300 characters at most, which is at most this many bytes.
    static let previewBytes = 1200
    static let hashBytes = 128
    static let usernameBytes = 64
    static let displayNameBytes = 512
    static let bioBytes = 2048
    /// A page of the feed or of activity.
    static let page = 100
    static let replies = 1000
    static let members = 10_000

    static func fits(_ text: String?, _ bytes: Int) -> Bool { (text?.utf8.count ?? 0) <= bytes }
}

extension NetworkPost {
    var fitsLimits: Bool {
        NetworkLimits.fits(text, NetworkLimits.textBytes) && NetworkLimits.fits(hash, NetworkLimits.hashBytes)
            && NetworkLimits.fits(parent, NetworkLimits.hashBytes) && mentions.count <= NetworkLimits.mentions
            && mentions.allSatisfy { NetworkLimits.fits($0.username, NetworkLimits.usernameBytes) }
            && embeds.count <= NetworkMessages.maxEmbeds && embeds.allSatisfy(\.fitsLimits)
    }

    /// The posts that fit, from the first `limit`.
    static func kept(_ posts: [NetworkPost], limit: Int) -> [NetworkPost] {
        posts.prefix(limit).filter(\.fitsLimits)
    }
}

extension NetworkPost.Embed {
    var fitsLimits: Bool {
        NetworkLimits.fits(type, 16) && NetworkLimits.fits(url, NetworkLimits.linkBytes) && NetworkLimits.fits(hash, NetworkLimits.hashBytes)
            && NetworkLimits.fits(post?.text, NetworkLimits.textBytes) && NetworkLimits.fits(post?.hash, NetworkLimits.hashBytes)
            && NetworkLimits.fits(src, NetworkLimits.addressBytes) && NetworkLimits.fits(full, NetworkLimits.addressBytes)
            && NetworkLimits.fits(preview?.title, NetworkLimits.previewBytes)
            && NetworkLimits.fits(preview?.description, NetworkLimits.previewBytes)
            && NetworkLimits.fits(preview?.image, NetworkLimits.addressBytes)
    }
}

extension NetworkMember {
    var fitsLimits: Bool {
        NetworkLimits.fits(username, NetworkLimits.usernameBytes) && NetworkLimits.fits(displayName, NetworkLimits.displayNameBytes)
            && NetworkLimits.fits(bio, NetworkLimits.bioBytes) && NetworkLimits.fits(role, 16)
            && NetworkLimits.fits(avatar, NetworkLimits.addressBytes)
    }
}

enum NetworkError: LocalizedError, Equatable {
    case server(status: Int, message: String)
    case unreachable
    case refused
    case notSignedIn

    var errorDescription: String? {
        switch self {
        case .server(_, let message): message
        case .unreachable: "Couldn’t reach the network."
        case .refused: "You’re not a member of this network."
        case .notSignedIn: "Sign in to this network again."
        }
    }
}

/// Farcaster's ID registry on Optimism, read directly, so no server can say who owns an FID.
enum Optimism {
    /// Public Optimism RPCs, tried in order, since any one can turn requests away for a while.
    private static var rpcs: [URL] {
        #if DEBUG
        // `npm run demo -- --app` prints a stand-in for Optimism, so a local demo network can be joined.
        if let local = ProcessInfo.processInfo.environment["FATLINE_OPTIMISM_URL"], let url = URL(string: local) { return [url] }
        #endif
        return ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"].compactMap(URL.init(string:))
    }
    private static let idRegistry = "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b"

    /// The FID an address owns, or nil.
    static func fid(owning address: String) async throws -> UInt64? {
        for rpc in rpcs {
            do {
                return try await fid(owning: address, rpc: rpc)
            } catch {
                continue
            }
        }
        throw NetworkError.server(status: 0, message: "Couldn’t reach Optimism to look up your account.")
    }

    private static func fid(owning address: String, rpc: URL) async throws -> UInt64? {
        let argument = String(repeating: "0", count: 24) + address.lowercased().dropFirst(2)
        var request = URLRequest(url: rpc, timeoutInterval: 8)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0", "id": 1, "method": "eth_call",
            "params": [["to": idRegistry, "data": "0xd94fe832" + argument], "latest"]
        ])
        let (data, response) = try await HTTP.loadResponse(request)
        struct Answer: Decodable { let result: String? }
        guard response.statusCode == 200, let result = try JSONDecoder().decode(Answer.self, from: data).result,
              let value = UInt64(result.dropFirst(2).suffix(16), radix: 16) else {
            throw NetworkError.server(status: response.statusCode, message: "Couldn’t reach Optimism to look up your account.")
        }
        return value == 0 ? nil : value
    }
}

/// What `GET /invites/{code}` says: the network's name and picture link, as it gives them.
struct NetworkInvite: Decodable, Hashable, Sendable {
    let name: String?
    let icon: String?

    init(name: String?, icon: String?) {
        self.name = name
        self.icon = icon
    }

    init(data: Data) throws {
        do {
            self = try JSONDecoder().decode(Self.self, from: data)
        } catch {
            throw NetworkError.server(status: 0, message: "The network sent something Fatline couldn’t read.")
        }
    }
}

/// Talks to one network's server as this device.
struct NetworkClient: Sendable {
    let membership: NetworkMembership

    private var base: URL { NetworkMessages.origin(membership.host).appending(path: "api/v1") }

    // MARK: Joining and signing in

    static func join(host: String, device: NetworkDevice, invite: String?, avatar: String? = nil) async throws -> NetworkMembership {
        let key = Curve25519.Signing.PrivateKey()
        let issued = Int64(Date.now.timeIntervalSince1970)
        let text = NetworkMessages.networkKeyText(host: host, fid: device.fid, networkKey: key.publicKey.rawRepresentation, issued: issued)
        let approval = try device.signingKey.signature(for: Data(text.utf8)).hex
        var membership = NetworkMembership(host: host, fid: device.fid, key: key.rawRepresentation, issued: issued,
                                           approval: approval, status: .pending)
        var body: [String: Any] = [
            "fid": device.fid,
            "deviceKey": try device.signingKey.publicKey.rawRepresentation.hex,
            "deviceApproval": ["issuedAt": device.issuedAt, "signature": device.signature],
            "networkKey": key.publicKey.rawRepresentation.hex,
            "networkApproval": ["issued": issued, "signature": approval],
        ]
        if let invite { body["invite"] = invite }
        if let avatar { body["avatar"] = avatar }
        struct Answer: Decodable { let status: NetworkMembership.Status }
        let answer: Answer = try await NetworkClient(membership: membership).call("POST", "join", json: body, signedIn: false)
        membership.status = answer.status
        return membership
    }

    /// What a network's invite page shows for `code`, or nil when the network doesn't know the code.
    /// It sends nothing about this device or account, so the app can show it before anything is sent.
    static func invite(host: String, code: String) async throws -> NetworkInvite? {
        // Only the characters invite codes are made of, so a code can't reach another path.
        guard !code.isEmpty, code.count <= 128,
              code.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII || "-._~".unicodeScalars.contains($0) })
        else { return nil }
        let nobody = NetworkMembership(host: host, fid: 0, key: Data(), issued: 0, approval: "", status: .pending)
        let (data, status) = try await NetworkClient(membership: nobody).send("GET", "invites/\(code)", token: nil)
        switch status {
        case 200: return try NetworkInvite(data: data)
        case 404: return nil
        default: throw Self.error(status: status, data: data)
        }
    }

    /// Signs in once approved. Returns the membership with its new token, or its new status.
    func signIn() async throws -> NetworkMembership {
        var updated = membership
        let issued = Int64(Date.now.timeIntervalSince1970)
        let nonce = Data((0..<16).map { _ in UInt8.random(in: 0...255) }).hex
        let text = NetworkMessages.sessionText(host: membership.host, fid: membership.fid, issued: issued, nonce: nonce)
        let signature = try membership.signingKey.signature(for: Data(text.utf8)).hex
        let body: [String: Any] = [
            "fid": membership.fid, "networkKey": try membership.signingKey.publicKey.rawRepresentation.hex,
            "issued": issued, "nonce": nonce, "signature": signature,
        ]
        let (data, status) = try await send("POST", "session", json: body, token: nil)
        switch status {
        case 200:
            struct Session: Decodable { let token: String; let expires: Int64 }
            let session = try JSONDecoder().decode(Session.self, from: data)
            updated.status = .approved
            updated.token = session.token
            updated.expires = session.expires
        case 202: updated.status = .pending
        case 403: updated.status = .refused
        default: throw Self.error(status: status, data: data)
        }
        return updated
    }

    // MARK: Reading

    /// The network's name is held to 64 characters by `NetworkMembership.acceptedName`.
    func info() async throws -> NetworkInfo {
        var info: NetworkInfo = try await call("GET", "network")
        guard info.you.fitsLimits else { throw Self.unreadable }
        if !NetworkLimits.fits(info.icon, NetworkLimits.addressBytes) { info.icon = nil }
        return info
    }

    func feed() async throws -> [NetworkPost] {
        struct Page: Decodable { let posts: [NetworkPost] }
        let page: Page = try await call("GET", "feed")
        return NetworkPost.kept(page.posts, limit: NetworkLimits.page)
    }

    func thread(_ hash: String) async throws -> (post: NetworkPost, replies: [NetworkPost]) {
        struct Thread: Decodable { let post: NetworkPost; let replies: [NetworkPost] }
        let thread: Thread = try await call("GET", "posts/\(hash)")
        guard thread.post.fitsLimits else { throw Self.unreadable }
        return (thread.post, NetworkPost.kept(thread.replies, limit: NetworkLimits.replies))
    }

    func activity() async throws -> [NetworkActivity.Item] {
        let page: NetworkActivity = try await call("GET", "activity")
        return page.items.prefix(NetworkLimits.page).filter { item in
            NetworkLimits.fits(item.kind, 16) && item.post.fitsLimits && item.parent?.fitsLimits != false
        }
    }

    func members() async throws -> [NetworkMember] {
        struct Members: Decodable { let members: [NetworkMember] }
        let members: Members = try await call("GET", "members")
        return members.members.prefix(NetworkLimits.members).filter(\.fitsLimits)
    }

    // MARK: Changing

    func submit(_ message: SnapchainMessage) async throws {
        struct Answer: Decodable { let hash: String }
        let _: Answer = try await call("POST", "messages", bytes: message.bytes)
    }

    func adminLink() async throws -> URL {
        struct Answer: Decodable { let url: String }
        let answer: Answer = try await call("POST", "admin-link")
        guard let url = URL(string: answer.url), url.host() == NetworkMessages.origin(membership.host).host() else {
            throw NetworkError.server(status: 0, message: "The network sent a link somewhere else.")
        }
        return url
    }

    func leave() async throws {
        try await expectNoContent("POST", "leave")
    }

    /// Ends the session this token belongs to, and no other. The device keeps its keys.
    func endSession() async throws {
        try await expectNoContent("DELETE", "session")
    }

    func mute(_ fid: UInt64, _ muted: Bool) async throws {
        try await expectNoContent(muted ? "PUT" : "DELETE", "mutes/\(fid)")
    }

    func report(_ hash: String, note: String) async throws {
        try await expectNoContent("POST", "reports", json: ["post": hash, "note": note])
    }

    func updateProfile(displayName: String, bio: String) async throws -> NetworkMember {
        try Self.fitting(await call("PATCH", "me", json: ["displayName": displayName, "bio": bio]))
    }

    /// An uploaded picture's ID, or "farcaster" to go back to the Farcaster picture.
    func setAvatar(_ avatar: String) async throws -> NetworkMember {
        try Self.fitting(await call("PATCH", "me", json: ["avatar": avatar]))
    }

    private static func fitting(_ member: NetworkMember) throws -> NetworkMember {
        guard member.fitsLimits else { throw unreadable }
        return member
    }

    struct Uploaded: Decodable, Sendable {
        let id: String
        let url: String

        private static let idCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

        /// Whether `url` is the network's own `https://<host>/m/<id>` address for this picture. A post
        /// carries it signed with the user's key, so a server mustn't choose a link of its own.
        func isOwnLink(on host: String) -> Bool {
            (1...64).contains(id.count) && id.allSatisfy(Self.idCharacters.contains) && url == "https://\(host)/m/\(id)"
        }
    }

    func upload(_ data: Data, type: String) async throws -> Uploaded {
        let uploaded: Uploaded = try await call("POST", "media", bytes: data, contentType: type)
        guard uploaded.isOwnLink(on: membership.host) else {
            throw NetworkError.server(status: 0, message: "The network sent a picture link that isn’t its own.")
        }
        return uploaded
    }

    /// Admins only: how many people are waiting to join.
    func waitingRequests() async throws -> Int {
        struct Request: Decodable { let status: String }
        struct Requests: Decodable { let requests: [Request] }
        let answer: Requests = try await call("GET", "admin/requests")
        return answer.requests.filter { $0.status == "pending" }.count
    }

    // MARK: Requests

    private func expectNoContent(_ method: String, _ path: String, json: [String: Any]? = nil) async throws {
        if membership.token == nil { throw NetworkError.notSignedIn }
        let (data, status) = try await send(method, path, json: json, token: membership.token)
        guard (200..<300).contains(status) else { throw Self.error(status: status, data: data) }
    }

    private func call<Answer: Decodable>(_ method: String, _ path: String, json: [String: Any]? = nil,
                                         bytes: Data? = nil, contentType: String? = nil, signedIn: Bool = true) async throws -> Answer {
        if signedIn && membership.token == nil { throw NetworkError.notSignedIn }
        let (data, status) = try await send(method, path, json: json, bytes: bytes, contentType: contentType, token: signedIn ? membership.token : nil)
        guard (200..<300).contains(status) else { throw Self.error(status: status, data: data) }
        do {
            return try JSONDecoder().decode(Answer.self, from: data)
        } catch {
            throw Self.unreadable
        }
    }

    private static let unreadable = NetworkError.server(status: 0, message: "The network sent something Fatline couldn’t read.")

    /// Which app and version this is, such as `mac/0.3.91`, so a network can ask old builds to update.
    static let appHeader: String = {
        #if os(macOS)
        let platform = "mac"
        #else
        let platform = "iphone"
        #endif
        return "\(platform)/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0")"
    }()

    private func send(_ method: String, _ path: String, json: [String: Any]? = nil, bytes: Data? = nil,
                      contentType: String? = nil, token: String?) async throws -> (Data, Int) {
        var request = URLRequest(url: base.appending(path: path), cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: bytes.map { $0.count > 1_000_000 ? 120 : 30 } ?? 30)
        request.httpMethod = method
        request.setValue(Self.appHeader, forHTTPHeaderField: "fatline-app")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        } else if let bytes {
            request.setValue(contentType ?? "application/octet-stream", forHTTPHeaderField: "content-type")
            request.httpBody = bytes
        }
        do {
            let (data, response) = try await HTTP.loadResponse(request)
            return (data, response.statusCode)
        } catch {
            throw NetworkError.unreachable
        }
    }

    private static func error(status: Int, data: Data) -> NetworkError {
        struct Problem: Decodable { let message: String?; let status: String? }
        let problem = try? JSONDecoder().decode(Problem.self, from: data)
        if status == 401 { return .notSignedIn }
        if status == 403, problem?.status == "refused" { return .refused }
        return .server(status: status, message: problem?.message ?? "The network answered \(status).")
    }
}

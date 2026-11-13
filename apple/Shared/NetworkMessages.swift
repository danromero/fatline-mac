import CryptoKit
import Foundation

/// What Fatline networks sign, as docs/NETWORK.md describes. Posts, replies, likes, and deletions are
/// Farcaster messages with no network field, signed by a key only that network knows.
enum NetworkMessages {
    static let maxCharacters = 280
    static let maxTextBytes = 1024
    static let maxEmbeds = 2

    enum Embed: Equatable {
        case link(String)
        case post(fid: UInt64, hash: String)
    }

    /// Characters as a person sees them, with each mention as @username. Swift counts these already.
    static func characterCount(_ text: String) -> Int { text.count }

    /// A post, or a reply when `parent` is set. `handles` maps a lowercase username to a member's FID.
    static func post(fid: UInt64, text: String, handles: [String: UInt64], embeds: [Embed] = [],
                     parent: (fid: UInt64, hash: String)? = nil, key: Curve25519.Signing.PrivateKey,
                     date: Date = .now) throws -> SnapchainMessage {
        let mentions = CastMentions(draft: text, handles: handles)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!trimmed.isEmpty || !embeds.isEmpty), characterCount(text) <= maxCharacters,
              mentions.text.utf8.count <= maxTextBytes, embeds.count <= maxEmbeds else {
            throw PostingError.invalidCast
        }
        var fids = Protobuf()
        mentions.fids.forEach { fids.packed($0) }
        var positions = Protobuf()
        mentions.positions.forEach { positions.packed(UInt64($0)) }

        // Field order, and the packed lists written even when empty, match the Farcaster SDK.
        var body = Protobuf()
        body.bytes(2, fids.data)
        if let parent { body.bytes(3, try castId(fid: parent.fid, hash: parent.hash)) }
        if !mentions.text.isEmpty { body.bytes(4, Data(mentions.text.utf8)) }
        body.bytes(5, positions.data)
        for embed in embeds {
            var encoded = Protobuf()
            switch embed {
            case .link(let url):
                guard url.hasPrefix("https://"), url.utf8.count <= 256 else { throw PostingError.invalidCast }
                encoded.bytes(1, Data(url.utf8))
            case .post(let fid, let hash):
                encoded.bytes(2, try castId(fid: fid, hash: hash))
            }
            body.bytes(6, encoded.data)
        }
        return try SnapchainMessage.sign(type: 1, field: 5, body: body.data, fid: fid, key: key, date: date, network: nil)
    }

    static func removal(fid: UInt64, target: String, key: Curve25519.Signing.PrivateKey) throws -> SnapchainMessage {
        guard let hash = Data(hex: target.lowercased()), hash.count == 20 else { throw PostingError.invalidCast }
        var body = Protobuf()
        body.bytes(1, hash)
        return try SnapchainMessage.sign(type: 2, field: 6, body: body.data, fid: fid, key: key, network: nil)
    }

    static func like(_ add: Bool, fid: UInt64, target: (fid: UInt64, hash: String), key: Curve25519.Signing.PrivateKey) throws -> SnapchainMessage {
        var body = Protobuf()
        body.integer(1, 1) // Like
        body.bytes(2, try castId(fid: target.fid, hash: target.hash))
        return try SnapchainMessage.sign(type: add ? 3 : 4, field: 7, body: body.data, fid: fid, key: key, network: nil)
    }

    private static func castId(fid: UInt64, hash: String) throws -> Data {
        guard let bytes = Data(hex: hash.lowercased()), bytes.count == 20 else { throw PostingError.invalidCast }
        var id = Protobuf()
        id.integer(1, fid)
        id.bytes(2, bytes)
        return id.data
    }

    /// What a device key signs to approve a network key for one network.
    static func networkKeyText(host: String, fid: UInt64, networkKey: Data, issued: Int64) -> String {
        ["Fatline network key", "network: \(host)", "fid: \(fid)", "key: \(networkKey.hex)", "issued: \(issued)"].joined(separator: "\n")
    }

    /// What a network key signs to get a session token.
    static func sessionText(host: String, fid: UInt64, issued: Int64, nonce: String) -> String {
        ["Fatline session", "network: \(host)", "fid: \(fid)", "issued: \(issued)", "nonce: \(nonce)"].joined(separator: "\n")
    }

    /// A network's host from what someone typed: `friends.example.com`, `https://friends.example.com`,
    /// or, in Debug builds, `localhost:8787` over plain HTTP for testing a local server.
    static func host(from typed: String) -> String? {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URLComponents(string: text), let name = url.host, !name.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { return nil }
        let local = name == "localhost" || name == "127.0.0.1"
        #if DEBUG
        guard url.scheme == "https" || (url.scheme == "http" && local) else { return nil }
        #else
        guard url.scheme == "https", !local else { return nil }
        #endif
        return (url.port.map { "\(name):\($0)" } ?? name).lowercased()
    }

    /// Where requests go for a host.
    static func origin(_ host: String) -> URL {
        let local = host == "localhost" || host.hasPrefix("localhost:") || host == "127.0.0.1" || host.hasPrefix("127.0.0.1:")
        return URL(string: "\(local ? "http" : "https")://\(host)")!
    }
}

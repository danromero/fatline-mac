import XCTest
@testable import Fatline

/// What the app takes from a network server, which might not be honest.
final class NetworkLimitsTests: XCTestCase {
    private func uploaded(id: String, url: String) throws -> NetworkClient.Uploaded {
        try JSONDecoder().decode(NetworkClient.Uploaded.self, from: Data(#"{"id":"\#(id)","url":"\#(url)"}"#.utf8))
    }

    func testAnUploadMustLinkToTheNetworksOwnPicture() throws {
        let host = "harbor.example.net"
        XCTAssertTrue(try uploaded(id: "Ab9_-x", url: "https://harbor.example.net/m/Ab9_-x").isOwnLink(on: host))
        XCTAssertTrue(try uploaded(id: "Ab9", url: "https://localhost:8787/m/Ab9").isOwnLink(on: "localhost:8787"))
        for (id, url) in [
            ("Ab9", "https://evil.example.com/m/Ab9"),
            ("Ab9", "http://harbor.example.net/m/Ab9"),
            ("Ab9", "https://harbor.example.net/m/Other"),
            ("Ab9", "https://harbor.example.net/media/Ab9"),
            ("Ab9", "https://harbor.example.net/m/Ab9?x=1"),
            ("Ab9", "https://harbor.example.net.evil.com/m/Ab9"),
            ("A/b", "https://harbor.example.net/m/A/b"),
            ("", "https://harbor.example.net/m/"),
            (String(repeating: "a", count: 65), "https://harbor.example.net/m/" + String(repeating: "a", count: 65)),
        ] {
            XCTAssertFalse(try uploaded(id: id, url: url).isOwnLink(on: host), url)
        }
    }

    private func post(text: String = "hi", mentions: Int = 0, embeds: [String] = []) throws -> NetworkPost {
        let mentioned = (0..<mentions).map { #"{"fid":\#($0),"username":"u\#($0)"}"# }.joined(separator: ",")
        let json = #"{"hash":"0xab","fid":3,"time":1,"text":\#(String(data: try JSONEncoder().encode(text), encoding: .utf8)!),"mentions":[\#(mentioned)],"parent":null,"embeds":[\#(embeds.joined(separator: ","))],"replies":0,"likes":0,"liked":false,"deleted":false}"#
        return try JSONDecoder().decode(NetworkPost.self, from: Data(json.utf8))
    }

    func testPostsPastWhatANetworkCanSendAreDropped() throws {
        let link = #"{"type":"link","url":"https://example.com"}"#
        let fine = try post(text: String(repeating: "é", count: 280), mentions: 10, embeds: [link, link])
        XCTAssertTrue(fine.fitsLimits)
        for tooMuch in [
            try post(text: String(repeating: "a", count: 1025)),
            try post(mentions: 11),
            try post(embeds: [link, link, link]),
            try post(embeds: [#"{"type":"link","url":"https://example.com/\#(String(repeating: "a", count: 300))"}"#]),
            try post(embeds: [#"{"type":"link","url":"https://example.com","preview":{"title":"\#(String(repeating: "a", count: 5000))"}}"#]),
            try post(embeds: [#"{"type":"post","hash":"0xcd","post":{"hash":"0xcd","fid":4,"text":"\#(String(repeating: "a", count: 2000))"}}"#]),
        ] {
            XCTAssertFalse(tooMuch.fitsLimits)
        }
        let kept = NetworkPost.kept(Array(repeating: fine, count: 150) + [try post(text: String(repeating: "a", count: 5000))], limit: 100)
        XCTAssertEqual(kept.count, 100)
    }

    func testMembersPastWhatANetworkCanSendAreDropped() throws {
        func member(bio: String) throws -> NetworkMember {
            let json = #"{"fid":3,"username":"dwr","displayName":"Dan","bio":"\#(bio)","role":"member","joined":1,"muted":false}"#
            return try JSONDecoder().decode(NetworkMember.self, from: Data(json.utf8))
        }
        XCTAssertTrue(try member(bio: "Hello").fitsLimits)
        XCTAssertFalse(try member(bio: String(repeating: "a", count: 100_000)).fitsLimits)
    }
}

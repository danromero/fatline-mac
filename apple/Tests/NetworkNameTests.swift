import XCTest
@testable import Fatline

/// A network's own name shows only when it can't pass for Farcaster or another network.
final class NetworkNameTests: XCTestCase {
    private func membership(_ host: String, name: String? = nil) -> NetworkMembership {
        NetworkMembership(host: host, fid: 3, key: Data(repeating: 1, count: 32), issued: 0, approval: "", status: .approved, name: name)
    }

    private let harbor = "harbor.example.net"

    func testAPlainNameShows() {
        XCTAssertEqual(NetworkMembership.acceptedName(" Harbor Crew ", host: harbor, others: []), "Harbor Crew")
        XCTAssertEqual(NetworkMembership.acceptedName("Café 👨‍👩‍👧", host: harbor, others: []), "Café 👨‍👩‍👧")
        XCTAssertEqual(NetworkMembership.acceptedName(harbor, host: harbor, others: []), harbor, "its own host is fine")
    }

    func testANameThatPassesForSomethingElseShowsTheHost() {
        let others = [membership(harbor, name: "Harbor Crew"), membership("friends.example.com")]
        for name in ["Harbor Crew", "harbor crew", "Ｈａｒｂｏｒ Ｃｒｅｗ", "Farcaster", "farcaster", "Fatline", "friends.example.com", "other.example.org"] {
            XCTAssertNil(NetworkMembership.acceptedName(name, host: "evil.example.net", others: others), name)
        }
        XCTAssertEqual(NetworkMembership.acceptedName("Harbor Crew", host: harbor, others: others), "Harbor Crew", "its own name is fine")
    }

    func testHiddenOrReversedOrLongNamesShowTheHost() {
        for name in ["Harbor\u{200B} Crew", "\u{202E}werC robraH", "Harbor Crew\u{2066}", "\u{3164}", "", "   ", String(repeating: "a", count: 65)] {
            XCTAssertNil(NetworkMembership.acceptedName(name, host: "evil.example.net", others: []), name.debugDescription)
        }
    }

    func testTheLabelNamesTheHost() {
        XCTAssertEqual(membership(harbor, name: "Harbor Crew").label, "Harbor Crew · harbor.example.net")
        XCTAssertEqual(membership(harbor).label, harbor)
    }

    func testAMarkWithoutAPictureShowsTheFirstLetter() {
        XCTAssertEqual(NetworkMarkImage.letter("pine street"), "P")
        XCTAssertEqual(NetworkMarkImage.letter("9 Elms"), "9")
        XCTAssertEqual(NetworkMarkImage.letter("émile"), "É")
        XCTAssertEqual(NetworkMarkImage.letter(""), "?")
    }
}

import XCTest
@testable import Fatline

/// The confirm step before joining shows what an invite code's network says about itself, checked as
/// for a network joined, and nothing at all for an address alone.
final class NetworkInviteTests: XCTestCase {
    func testTheInviteAnswerParses() throws {
        let invite = try NetworkInvite(data: Data(#"{"name":"Pine Street","icon":"https://pine.example/icon?v=2"}"#.utf8))
        XCTAssertEqual(invite, NetworkInvite(name: "Pine Street", icon: "https://pine.example/icon?v=2"))
        XCTAssertEqual(try NetworkInvite(data: Data(#"{"name":null,"icon":null}"#.utf8)), NetworkInvite(name: nil, icon: nil))
        XCTAssertThrowsError(try NetworkInvite(data: Data("<html>Not found</html>".utf8)))
    }

    @MainActor
    func testTheConfirmStepChecksTheName() {
        let cabin = NetworkMembership(host: "cabin.example", fid: 3, key: Data(repeating: 1, count: 32), issued: 0, approval: "",
                                      status: .approved, name: "Cabin")
        let pine = NetworkJoiner.Preview.make(host: "pine.example", invite: NetworkInvite(name: "Pine Street", icon: nil), others: [cabin])
        XCTAssertTrue(pine.hasInvite)
        XCTAssertEqual(pine.name, "Pine Street")
        for name in ["Farcaster", "Cabin", "cabin.example", "Pine\u{202E} Street"] {
            let fake = NetworkJoiner.Preview.make(host: "evil.example", invite: NetworkInvite(name: name, icon: nil), others: [cabin])
            XCTAssertNil(fake.name, "\(name.debugDescription) shows the host instead")
        }
        let asking = NetworkJoiner.Preview.make(host: "pine.example", invite: nil, others: [cabin])
        XCTAssertFalse(asking.hasInvite)
        XCTAssertNil(asking.name)
        XCTAssertNil(asking.icon)
    }
}

import XCTest
@testable import Fatline

final class BuildFeedTests: XCTestCase {
    private func feed(_ build: Int, link: String = "https://testflight.apple.com/join/SnTSSbrE") -> Data {
        Data(#"{"build": \#(build), "link": "\#(link)"}"#.utf8)
    }

    func testANewerBuildIsOffered() {
        XCTAssertEqual(BuildFeed.offer(feed(10), current: 9, announced: 0)?.build, 10)
    }

    func testTheSameOrAnOlderBuildIsnt() {
        XCTAssertNil(BuildFeed.offer(feed(9), current: 9, announced: 0))
        XCTAssertNil(BuildFeed.offer(feed(8), current: 9, announced: 0))
    }

    func testABuildIsOfferedOnce() {
        XCTAssertNil(BuildFeed.offer(feed(10), current: 9, announced: 10))
        XCTAssertEqual(BuildFeed.offer(feed(11), current: 9, announced: 10)?.build, 11)
    }

    func testOnlyATestFlightLinkIsOffered() {
        XCTAssertNil(BuildFeed.offer(feed(10, link: "https://example.com/join/SnTSSbrE"), current: 9, announced: 0))
        XCTAssertNil(BuildFeed.offer(feed(10, link: "http://testflight.apple.com/join/SnTSSbrE"), current: 9, announced: 0))
        XCTAssertNil(BuildFeed.offer(Data("not json".utf8), current: 9, announced: 0))
    }

    /// The file fatline.tech serves has to stay readable by the app.
    func testTheSiteFileDecodes() throws {
        let file = URL(filePath: #filePath).deletingLastPathComponent()
            .appending(path: "../../site/public/ios/latest.json")
        guard let data = try? Data(contentsOf: file) else { throw XCTSkip("The site isn't next to apple/ in the public repo.") }
        XCTAssertNotNil(try? JSONDecoder().decode(BuildFeed.self, from: data))
    }
}

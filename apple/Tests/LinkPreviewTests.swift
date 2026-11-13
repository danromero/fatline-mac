import XCTest
@testable import Fatline

/// The link card a network post gets: which link, and what the page says about itself.
final class LinkPreviewTests: XCTestCase {
    func testTheFirstSecureLinkBecomesTheCard() {
        XCTAssertEqual(LinkPreview.firstLink(in: "Lunch at https://example.com/menu today")?.absoluteString, "https://example.com/menu")
        XCTAssertEqual(LinkPreview.firstLink(in: "Lunch at example.com/menu")?.absoluteString, "https://example.com/menu", "a bare address gets https")
        XCTAssertEqual(LinkPreview.firstLink(in: "http://plain.example.com then https://b.example.com")?.absoluteString, "https://b.example.com",
                       "a link typed with http stays text")
        XCTAssertNil(LinkPreview.firstLink(in: "No links here."))
    }

    func testAPageNamesItselfWithItsTagsOrItsTitle() {
        let tagged = LinkPreview.parse(#"<head><title>Plain</title><meta property="og:title" content="Tom &amp; Jerry"><meta name="description" content='A &quot;cat&quot;'></head>"#)
        XCTAssertEqual(tagged, LinkPreview(title: "Tom & Jerry", description: "A \"cat\""))
        XCTAssertEqual(LinkPreview.parse("<title> Only a title </title>"), LinkPreview(title: "Only a title", description: nil))
        XCTAssertEqual(LinkPreview.parse("<p>nothing</p>"), LinkPreview(title: nil, description: nil))
    }
}

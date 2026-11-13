import ImageIO
import SwiftUI
import XCTest
@testable import Fatline

final class CastLinkTests: XCTestCase {
    private func links(in text: String) -> [URL] {
        FeedCast.linkedText(text).runs.compactMap { $0.link }
    }

    func testALookalikeHostStaysPlainText() {
        XCTAssertEqual(links(in: "See https://xn--pple-43d.com/login"), [])
        // The first letter is Cyrillic.
        XCTAssertEqual(links(in: "See https://\u{0430}pple.com/login"), [])
    }

    func testABareAddressOpensOverHTTPS() {
        XCTAssertEqual(links(in: "See example.org/b").map(\.scheme), ["https"])
    }

    func testAnAddressWrittenWithHTTPKeepsIt() {
        XCTAssertEqual(links(in: "See http://example.org/b").map(\.scheme), ["http"])
    }

    func testOnlySoManyLinksAreMade() {
        let text = (0..<30).map { "https://example.com/\($0)" }.joined(separator: " ")
        XCTAssertEqual(links(in: text).count, 20)
    }
}

final class CastImageTests: XCTestCase {
    private func picture(as type: String) throws -> Data {
        let color = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let context = try XCTUnwrap(CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: color, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.2, green: 0.5, blue: 0.3, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, type as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try XCTUnwrap(context.makeImage()), nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination), type)
        return data as Data
    }

    func testTheFormatsPeoplePostAreDecoded() throws {
        for type in ["public.jpeg", "public.png", "com.compuserve.gif", "public.heic"] {
            XCTAssertNotNil(CastImages.decode(try picture(as: type), maxPixels: 32), type)
        }
    }

    func testOtherFormatsAreRefusedEvenWhenTheSystemCouldReadThem() throws {
        for type in ["public.tiff", "com.microsoft.bmp", "com.adobe.photoshop-image"] {
            XCTAssertNil(CastImages.decode(try picture(as: type), maxPixels: 32), type)
        }
        XCTAssertNil(CastImages.decode(Data("not a picture".utf8), maxPixels: 32))
    }

    func testASizeThatWrapsAroundIsRefused() {
        XCTAssertTrue(CastImages.acceptsSize(width: 4000, height: 3000))
        XCTAssertFalse(CastImages.acceptsSize(width: 20_000, height: 20_000), "over the limit")
        let huge = Int(UInt32.max)
        XCTAssertFalse(CastImages.acceptsSize(width: huge, height: huge), "the product wraps around")
        XCTAssertFalse(CastImages.acceptsSize(width: 0, height: 100))
        XCTAssertFalse(CastImages.acceptsSize(width: -4, height: -4))
    }

    func testARedirectIsHeldToTheSameRulesAsTheCast() async throws {
        let redirects = CastImages.Redirects()
        let start = try XCTUnwrap(URL(string: "https://example.com/a.png"))
        let response = try XCTUnwrap(HTTPURLResponse(url: start, statusCode: 302, httpVersion: nil, headerFields: nil))
        let task = URLSession.shared.dataTask(with: start)

        func answer(_ address: String) async throws -> URL? {
            let next = URLRequest(url: try XCTUnwrap(URL(string: address)))
            return await redirects.urlSession(.shared, task: task, willPerformHTTPRedirection: response, newRequest: next)?.url
        }

        for address in ["http://example.com/a.png", "https://localhost/a.png", "https://127.0.0.1/a.png", "https://192.168.1.1/a.png", "https://[::1]/a.png", "https://printer.local/a.png", "https://router/a.png"] {
            let followed = try await answer(address)
            XCTAssertNil(followed, address)
        }
        let followed = try await answer("https://cdn.example.com/b.png")
        XCTAssertEqual(followed?.absoluteString, "https://cdn.example.com/b.png")
    }
}

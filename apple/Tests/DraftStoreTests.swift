import XCTest
@testable import Fatline

final class DraftStoreTests: XCTestCase {
    func testDraftPersistsAcrossStoreInstances() throws {
        let folder = try temporaryFolder()
        let draft = "First line\nSecond line"
        try DraftStore(directory: folder).save(draft)
        XCTAssertEqual(try DraftStore(directory: folder).load(), draft)
    }

    func testCorruptionRecoversPreviousDraftAndPreservesDamagedFile() throws {
        let folder = try temporaryFolder()
        let store = DraftStore(directory: folder)
        try store.save("Previous draft")
        try store.save("Current draft")
        let damaged = Data("Invalid JSON".utf8)
        let current = folder.appending(path: "draft.json")
        try damaged.write(to: current)
        XCTAssertEqual(try store.load(), "Previous draft")
        let preserved = try XCTUnwrap(
            FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
                .first { $0.lastPathComponent.hasPrefix("draft.unreadable-") }
        )
        XCTAssertEqual(try Data(contentsOf: preserved), damaged)
        try store.save("Recovered draft")
        XCTAssertEqual(try store.load(), "Recovered draft")
    }

    func testFutureSchemaIsPreserved() throws {
        let folder = try temporaryFolder()
        let current = folder.appending(path: "draft.json")
        let future = Data(#"{"version":2,"text":"Future draft"}"#.utf8)
        try future.write(to: current)
        let store = DraftStore(directory: folder)
        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try store.save("Replacement"))
        XCTAssertEqual(try Data(contentsOf: current), future)
    }

    private func temporaryFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: folder) }
        return folder
    }
}

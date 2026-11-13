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

    func testLegacyDraftOnlyMovesToTheFirstAccount() throws {
        let folder = try temporaryFolder()
        let legacy = DraftStore(directory: folder)
        let first = DraftStore(directory: folder.appending(path: "Accounts/1"))
        let second = DraftStore(directory: folder.appending(path: "Accounts/2"))
        try legacy.save("First account draft")
        try first.adoptLegacy(from: legacy)
        XCTAssertEqual(try first.load(), "First account draft")
        try legacy.save("Residual legacy draft")
        try second.adoptLegacy(from: legacy)
        XCTAssertEqual(try second.load(), "")
    }

    func testEachNetworkKeepsItsOwnDraft() throws {
        let folder = try temporaryFolder()
        let cabin = NetworkDrafts.store(for: "cabin.example", in: folder)
        let pine = NetworkDrafts.store(for: "localhost:8788", in: folder)
        try cabin.save("Dinner at 7?")
        try pine.save("Tables are in the garage")
        XCTAssertEqual(try NetworkDrafts.store(for: "cabin.example", in: folder).load(), "Dinner at 7?")
        XCTAssertEqual(try NetworkDrafts.store(for: "localhost:8788", in: folder).load(), "Tables are in the garage")
        // Posting clears the draft by saving it empty, as the Farcaster composer does.
        try cabin.save("")
        XCTAssertEqual(try cabin.load(), "")
        XCTAssertEqual(try pine.load(), "Tables are in the garage")
    }

    func testNetworkDraftFolderStaysInsideItsOwn() {
        XCTAssertEqual(NetworkDrafts.folderName("harbor.example.net"), "harbor.example.net")
        XCTAssertEqual(NetworkDrafts.folderName("localhost:8787"), "localhost:8787")
        XCTAssertEqual(NetworkDrafts.folderName("../x/y"), ".._x_y")
        XCTAssertEqual(NetworkDrafts.folderName(".."), "_..")
        XCTAssertEqual(NetworkDrafts.folderName(""), "_")
    }

    private func temporaryFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: folder) }
        return folder
    }
}

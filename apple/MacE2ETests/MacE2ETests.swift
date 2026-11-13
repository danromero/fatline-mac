import AppKit
import XCTest

/// Drives the real Mac app on the real network as a throwaway account, and checks the results on
/// Snapchain. They post and delete public casts. The runner sets `FATLINE_E2E_HANDLE` and
/// `FATLINE_E2E_FID` to that account, `FATLINE_E2E_VARS_FILE` to a file holding `NEYNAR_API_KEY=`, and
/// keeps the account's recovery phrase in the login Keychain under the service `fatline-e2e`.
///
/// The app runs with `-FatlineE2E`, which gives it its own Keychain items and folder, so a sign-in
/// saved on this Mac is never read or changed. Every test also confirms the account in Settings
/// before it can post.
///
/// A step that later steps depend on throws, because stopping an async test with
/// `continueAfterFailure = false` crashes the test runner.
@MainActor
final class MacE2ETests: XCTestCase {
    private struct Stop: LocalizedError {
        let errorDescription: String?
    }

    /// Never set these to a real account.
    private static let handle = ProcessInfo.processInfo.environment["FATLINE_E2E_HANDLE"] ?? ""
    private static let fid = ProcessInfo.processInfo.environment["FATLINE_E2E_FID"].flatMap(UInt64.init) ?? 0
    /// Cleanup deletes only casts that start with this, so make sure a real post never would.
    private static let castPrefix = "Automated Fatline Mac test "

    /// Only the first test of a run needs to sign out and in, or to look for leftover casts.
    private static var freshSignInDone = false
    private static var leftoversSwept = false

    private let environment = ProcessInfo.processInfo.environment
    private var network: LiveNetwork!

    // MARK: Tests

    func testPostReachesNetworkSurvivesRelaunchAndDeletes() async throws {
        let app = try await openSignedIn()
        let text = newCastText()

        try openComposer(app)
        try type(text, in: app)
        app.buttons["Post"].click()
        try expectToast("Sent", app: app, timeout: 45)
        XCTAssertFalse(app.textViews["Cast draft"].exists, "The composer should close after a post")
        try require(row(text, app).waitForExistence(timeout: 10), "The new cast should lead the feed")

        let cast = try await network.waitForCast(text: text)
        let signers = try await network.signers()
        let signer = try XCTUnwrap(signers.first { $0.key == cast.signer }, "The cast's signer isn't registered")
        XCTAssertEqual(Set(signer.scopes ?? []), ["MESSAGE_TYPE_CAST_ADD", "MESSAGE_TYPE_CAST_REMOVE"])

        app.terminate()
        try launchToFeed(app)
        try require(row(text, app).waitForExistence(timeout: 15), "The cast should still be there after a relaunch")
        app.typeKey("r", modifierFlags: .command)
        try require(row(text, app).waitForExistence(timeout: 15), "A refresh shouldn't lose the cast")

        try delete(row(text, app), app: app)
        try await network.waitUntilGone(text: text)
        try require(row(text, app).waitForNonExistence(timeout: 10), "A deleted cast should leave the feed")
    }

    func testKeyboardPostAndCancelledDelete() async throws {
        let app = try await openSignedIn()
        let text = newCastText()

        app.typeKey("n", modifierFlags: .command)
        try waitForComposer(app)
        try type(text, in: app)
        app.typeKey(.return, modifierFlags: .command)
        try expectToast("Sent", app: app, timeout: 45)
        let posted = row(text, app)
        try require(posted.waitForExistence(timeout: 10), "The new cast should lead the feed")
        _ = try await network.waitForCast(text: text)

        try openDeleteAlert(posted, app: app)
        app.buttons["Cancel"].click()
        try require(posted.waitForExistence(timeout: 5), "Cancel should keep the cast")
        let stillThere = try await network.recentCasts().contains { $0.text == text }
        XCTAssertTrue(stillThere, "Cancel shouldn't reach the network")

        try delete(posted, app: app)
        try await network.waitUntilGone(text: text)
    }

    func testDraftSurvivesCancelAndRelaunch() async throws {
        let app = try await openSignedIn()
        let text = "Unsent draft \(UUID().uuidString.prefix(8))"

        try openComposer(app)
        try type(text, in: app)
        app.buttons["Cancel"].click()
        try expectNoComposer(app)

        app.terminate()
        try launchToFeed(app)
        try openComposer(app)
        XCTAssertEqual(app.textViews["Cast draft"].value as? String, text)

        // Leaves nothing behind for the next run.
        try type("", in: app)
        app.buttons["Cancel"].click()
        try expectNoComposer(app)
    }

    func testPeopleMatchesTheNetwork() async throws {
        let app = try await openSignedIn()
        try openSettings(app)
        let people = app.descendants(matching: .any)["settings-people"]
        try require(people.waitForExistence(timeout: 5), "Settings should offer People")
        people.click()

        let refresh = app.buttons["refresh-people"]
        try require(refresh.waitForExistence(timeout: 5), "People should offer a refresh")
        refresh.click()
        let following = try await network.followCount()
        let rows = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Hide ' OR label BEGINSWITH 'Unhide '"))
        try await waitUntil("People to list \(following) accounts", timeout: 20) { rows.count == following }
        try closeSettings(app)
    }

    // MARK: Secrets

    // Read here rather than handed over in the environment, because xcodebuild copies the test
    // runner's whole environment into its result bundle.

    private func neynarKey() throws -> String {
        let path = try XCTUnwrap(environment["FATLINE_E2E_VARS_FILE"], "Set FATLINE_E2E_VARS_FILE to a file with NEYNAR_API_KEY in it")
        let line = try XCTUnwrap(
            String(contentsOfFile: path, encoding: .utf8).split(separator: "\n").first { $0.hasPrefix("NEYNAR_API_KEY=") },
            "No NEYNAR_API_KEY in FATLINE_E2E_VARS_FILE"
        )
        return line.dropFirst("NEYNAR_API_KEY=".count).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
    }

    private func recoveryPhrase() -> String? {
        let security = Process()
        security.executableURL = URL(filePath: "/usr/bin/security")
        security.arguments = ["find-generic-password", "-s", "fatline-e2e", "-a", Self.handle, "-w"]
        let output = Pipe()
        security.standardOutput = output
        security.standardError = FileHandle.nullDevice
        guard (try? security.run()) != nil else { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        security.waitUntilExit()
        guard security.terminationStatus == 0 else { return nil }
        let phrase = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return phrase.isEmpty ? nil : phrase
    }

    // MARK: Getting signed in

    /// Opens the app on the feed, signed in as the test account and no one else.
    private func openSignedIn() async throws -> XCUIApplication {
        try require(!Self.handle.isEmpty && Self.fid > 0, "Set FATLINE_E2E_HANDLE and FATLINE_E2E_FID to a throwaway account")
        let apiKey = try neynarKey()
        network = LiveNetwork(fid: Self.fid, apiKey: apiKey)

        let app = XCUIApplication()
        app.launchArguments = ["-FatlineE2E"]
        app.launch()
        app.activate()

        var signedIn = try await waitForFirstScreen(app)
        if signedIn, environment["FATLINE_E2E_FRESH"] == "1", !Self.freshSignInDone {
            try signOut(app)
            signedIn = false
        }
        if !signedIn { try await signIn(app, apiKey: apiKey) }
        Self.freshSignInDone = true

        try confirmTestAccount(app)
        try await sweepLeftovers(app)
        return app
    }

    private func waitForFirstScreen(_ app: XCUIApplication) async throws -> Bool {
        let feed = app.buttons["compose"]
        let welcome = app.buttons["welcome-continue"]
        var signedIn = false
        try await waitUntil("the feed or the welcome screen", timeout: 20) {
            signedIn = feed.exists
            return signedIn || welcome.exists
        }
        return signedIn
    }

    private func launchToFeed(_ app: XCUIApplication) throws {
        app.launch()
        app.activate()
        try require(app.buttons["compose"].waitForExistence(timeout: 20), "Should stay signed in across a relaunch")
    }

    private func signIn(_ app: XCUIApplication, apiKey: String) async throws {
        let startedAt = Date.now.timeIntervalSince1970
        app.buttons["welcome-continue"].click()

        let field = app.secureTextFields["connection-field"]
        try require(field.waitForExistence(timeout: 10), "Continue should reach the connection step")
        let submit = app.buttons["connection-continue"]
        try paste("not-a-real-neynar-key", into: field, app: app)
        submit.click()
        let refused = app.staticTexts["connection-error"]
        try require(refused.waitForExistence(timeout: 30), "A bad key should be refused")
        attachScreenshot("Bad key refused", app: app)

        try paste(apiKey, into: field, app: app)
        submit.click()

        let entry = app.descendants(matching: .any)["recovery-phrase-entry"]
        try require(entry.waitForExistence(timeout: 30), "A good key should reach the recovery phrase")
        guard let phrase = recoveryPhrase() else {
            throw XCTSkip("Connection checks passed. No recovery phrase, so stopping before sign-in.")
        }
        try paste(phrase, into: entry, app: app)
        let importButton = app.buttons["Import"]
        try require(importButton.isEnabled, "The phrase should fill the box")
        importButton.click()

        // Looking up an unknown address alone can take 45 seconds.
        let feed = app.buttons["compose"]
        let failed = app.staticTexts["recovery-error"]
        try await waitUntil("sign-in to finish", timeout: 90) {
            if failed.exists { throw Stop(errorDescription: "Sign-in failed: \(failed.value as? String ?? failed.label)") }
            return feed.exists
        }

        let added = try await network.signers().filter { $0.addedAt >= startedAt - 60 }
        XCTAssertEqual(added.count, 1, "Signing in should add one key to the network")
        XCTAssertEqual(Set(added.first?.scopes ?? []), ["MESSAGE_TYPE_CAST_ADD", "MESSAGE_TYPE_CAST_REMOVE"])

        app.terminate()
        try launchToFeed(app)
    }

    private func signOut(_ app: XCUIApplication) throws {
        try openSettings(app)
        let button = app.buttons["sign-out"]
        try require(button.waitForExistence(timeout: 5), "Settings should offer Sign Out")
        button.click()
        let confirm = alertButton("Sign Out", app: app)
        try require(confirm.waitForExistence(timeout: 5), "Sign Out should ask first")
        confirm.click()
        try require(app.buttons["welcome-continue"].waitForExistence(timeout: 10), "Sign Out should reach the welcome screen")
    }

    /// The guard that keeps a test from ever posting as anyone else.
    private func confirmTestAccount(_ app: XCUIApplication) throws {
        try openSettings(app)
        let account = app.descendants(matching: .any)["settings-account"]
        try require(account.waitForExistence(timeout: 5), "Settings should name the signed-in account")
        let shown = ([account.label, account.value as? String ?? ""] + account.staticTexts.allElementsBoundByIndex.map(\.label))
            .joined(separator: " ")
        try require(shown.contains(Self.handle), "Refusing to continue: this is signed in as someone other than @\(Self.handle)")
        try closeSettings(app)
    }

    /// A run that failed between posting and deleting leaves a public cast behind.
    private func sweepLeftovers(_ app: XCUIApplication) async throws {
        guard !Self.leftoversSwept else { return }
        Self.leftoversSwept = true
        for cast in try await network.recentCasts() where cast.text.hasPrefix(Self.castPrefix) {
            let leftover = row(cast.text, app)
            if leftover.waitForExistence(timeout: 5) {
                try delete(leftover, app: app)
                try await network.waitUntilGone(text: cast.text)
            } else {
                print("E2E-WARNING: can't reach leftover cast \(cast.hash) from the feed")
            }
        }
    }

    // MARK: Driving the app

    private func require(_ condition: Bool, _ reason: String) throws {
        if !condition { throw Stop(errorDescription: reason) }
    }

    private func newCastText() -> String {
        Self.castPrefix + UUID().uuidString.prefix(8).lowercased()
    }

    private func openComposer(_ app: XCUIApplication) throws {
        let plus = app.buttons["compose"]
        try require(plus.waitForExistence(timeout: 10), "The feed should offer Compose")
        plus.click()
        try waitForComposer(app)
    }

    private func waitForComposer(_ app: XCUIApplication) throws {
        try require(app.textViews["Cast draft"].waitForExistence(timeout: 10), "The composer should open")
    }

    private func expectNoComposer(_ app: XCUIApplication) throws {
        try require(app.textViews["Cast draft"].waitForNonExistence(timeout: 5), "The composer should close")
    }

    /// Replaces whatever is in the composer, including a draft left by an earlier run.
    private func type(_ text: String, in app: XCUIApplication) throws {
        let editor = app.textViews["Cast draft"]
        try waitUntilHittable(editor)
        editor.click()
        editor.typeKey("a", modifierFlags: .command)
        editor.typeKey(.delete, modifierFlags: [])
        if !text.isEmpty { editor.typeText(text) }
    }

    /// Secrets go in by clipboard, because the test log records typed text and not pasted text.
    /// This leaves the clipboard empty, since reading what was there first makes macOS ask permission.
    private func paste(_ secret: String, into field: XCUIElement, app: XCUIApplication) throws {
        try waitUntilHittable(field)
        let clipboard = NSPasteboard.general
        clipboard.clearContents()
        clipboard.setString(secret, forType: .string)
        defer { clipboard.clearContents() }
        field.click()
        app.typeKey("a", modifierFlags: .command)
        app.typeKey("v", modifierFlags: .command)
    }

    /// A screen can exist before it finishes sliding in, and a click during that fails.
    private func waitUntilHittable(_ element: XCUIElement) throws {
        let deadline = Date.now.addingTimeInterval(5)
        while !element.isHittable, Date.now < deadline { Thread.sleep(forTimeInterval: 0.2) }
        try require(element.isHittable, "\(element.description) should be clickable")
    }

    /// A row's combined text is its value on the Mac, not its label.
    private func row(_ text: String, _ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(identifier: "feed-cast")
            .matching(NSPredicate(format: "value CONTAINS %@", text))
            .firstMatch
    }

    private func expectToast(_ title: String, app: XCUIApplication, timeout: TimeInterval) throws {
        let toast = app.descendants(matching: .any)
            .matching(identifier: "post-toast")
            .matching(NSPredicate(format: "value CONTAINS %@", title))
            .firstMatch
        try require(toast.waitForExistence(timeout: timeout), "Expected the \(title) confirmation")
    }

    private func alertButton(_ title: String, app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != 'sign-out'", title)).firstMatch
    }

    /// A refresh that lands while the menu is open closes it, so this tries again.
    private func openDeleteAlert(_ row: XCUIElement, app: XCUIApplication) throws {
        let item = app.menuItems["Delete…"]
        var opened = false
        for _ in 0..<4 where !opened {
            row.rightClick()
            opened = item.waitForExistence(timeout: 3)
            if !opened { app.typeKey(.escape, modifierFlags: []) }
        }
        try require(opened, "Your own cast's menu should offer Delete")
        item.click()
        try require(alertButton("Delete", app: app).waitForExistence(timeout: 5), "Delete should ask first")
    }

    private func delete(_ row: XCUIElement, app: XCUIApplication) throws {
        try openDeleteAlert(row, app: app)
        alertButton("Delete", app: app).click()
        try expectToast("Deleted", app: app, timeout: 45)
    }

    /// By identifier, because the window's title changes to People on that screen.
    private func settingsWindow(_ app: XCUIApplication) -> XCUIElement {
        app.windows.matching(identifier: "settings").firstMatch
    }

    /// The menu item stays disabled for a moment after the feed appears, so this tries again.
    private func openSettings(_ app: XCUIApplication) throws {
        let settings = settingsWindow(app)
        for _ in 0..<5 where !settings.exists {
            app.typeKey(",", modifierFlags: .command)
            if settings.waitForExistence(timeout: 2) { return }
        }
        try require(settings.exists, "Settings should open")
    }

    /// Only ever the Settings window's own button, because closing the feed window quits the app.
    private func closeSettings(_ app: XCUIApplication) throws {
        let settings = settingsWindow(app)
        settings.buttons[XCUIIdentifierCloseWindow].click()
        try require(settings.waitForNonExistence(timeout: 5), "Settings should close")
    }

    private func waitUntil(_ what: String, timeout: TimeInterval, _ condition: () throws -> Bool) async throws {
        let deadline = Date.now.addingTimeInterval(timeout)
        while Date.now < deadline {
            if try condition() { return }
            try await Task.sleep(for: .milliseconds(250))
        }
        throw Stop(errorDescription: "Timed out waiting for \(what)")
    }

    private func attachScreenshot(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

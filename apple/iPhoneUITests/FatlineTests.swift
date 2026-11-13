import UIKit
import XCTest

final class FatlineTests: XCTestCase {
    @MainActor
    func testWelcomeAndRecoveryPhrasePaste() {
        let app = XCUIApplication()
        // The test simulator may be signed in from a manual check.
        app.launchArguments.append("-FatlineIgnoreSavedAccount")
        // A connection set at launch goes straight to the recovery phrase.
        app.launchEnvironment["FATLINE_SERVER_URL"] = "https://fatline.invalid"
        app.launch()
        XCTAssertTrue(app.buttons["welcome-continue"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons.count, 1)
        attachScreenshot("Welcome", app: app)
        app.buttons["welcome-continue"].tap()
        // Get started leads with Farcaster.
        let farcaster = app.buttons["setup-continue"]
        XCTAssertTrue(farcaster.waitForExistence(timeout: 5))
        farcaster.tap()
        let entry = app.descendants(matching: .any)["recovery-phrase-entry"]
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Import your account"].exists)
        let login = app.buttons["Import"]
        XCTAssertFalse(login.isEnabled)
        attachScreenshot("Recovery Phrase", app: app)
        entry.tap()
        entry.typeText("sample")
        let maskedText = entry.value as? String ?? ""
        XCTAssertEqual(maskedText.count, "sample".count)
        XCTAssertFalse(maskedText.contains("sample"))
        XCTAssertTrue(login.isHittable)
        attachScreenshot("Recovery Keyboard", app: app)
        let oneLine = entry.frame.height
        entry.typeText(String(repeating: " sample", count: 11))
        XCTAssertGreaterThan(entry.frame.height, oneLine)
        XCTAssertFalse((entry.value as? String ?? "").contains("sample"))
        XCTAssertTrue(login.isEnabled)
        attachScreenshot("Recovery Typed Wrapped", app: app)

        defer { UIPasteboard.general.items = [] }
        let paste = app.buttons["Paste"]
        UIPasteboard.general.string = Array(repeating: "invalid", count: 13).joined(separator: " ")
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        paste.tap()
        XCTAssertTrue(app.staticTexts["recovery-error"].waitForExistence(timeout: 5))
        XCTAssertFalse(login.isEnabled)
        let preview = app.buttons["recovery-phrase-preview"]
        XCTAssertEqual(preview.value as? String, "13 masked words")
        attachScreenshot("Recovery Validation", app: app)

        UIPasteboard.general.string = Array(repeating: "invalid", count: 24).joined(separator: " ")
        paste.tap()
        XCTAssertTrue(login.isEnabled)
        XCTAssertEqual(preview.value as? String, "24 masked words")
        attachScreenshot("Recovery Wrapped", app: app)

        UIPasteboard.general.string = Array(repeating: "invalid", count: 12).joined(separator: " ")
        paste.tap()
        XCTAssertTrue(login.isEnabled)
        XCTAssertEqual(preview.value as? String, "12 masked words")
        preview.tap()
        XCTAssertTrue(entry.waitForExistence(timeout: 5))
        XCTAssertTrue(login.isEnabled)
        login.tap()
        XCTAssertTrue(app.staticTexts["recovery-error"].waitForExistence(timeout: 5))
        XCTAssertFalse(login.isEnabled)
        XCTAssertFalse(UIPasteboard.general.hasStrings)

        UIPasteboard.general.string = Array(repeating: "invalid", count: 12).joined(separator: " ")
        paste.tap()
        XCTAssertTrue(login.isEnabled)
        UIPasteboard.general.string = "A newer clipboard item"
        login.tap()
        XCTAssertTrue(app.staticTexts["recovery-error"].waitForExistence(timeout: 5))
        XCTAssertEqual(UIPasteboard.general.string, "A newer clipboard item")

        UIPasteboard.general.string = Array(repeating: "invalid", count: 12).joined(separator: " ")
        entry.tap()
        entry.press(forDuration: 0.8)
        let editMenuPaste = app.menuItems["Paste"]
        XCTAssertTrue(editMenuPaste.waitForExistence(timeout: 5))
        editMenuPaste.tap()
        XCTAssertTrue(preview.waitForExistence(timeout: 5))
        XCTAssertEqual(preview.value as? String, "12 masked words")
        attachScreenshot("Recovery Edit Menu Paste", app: app)
        XCTAssertTrue(login.isEnabled)
        login.tap()
        XCTAssertTrue(app.staticTexts["recovery-error"].waitForExistence(timeout: 5))
        XCTAssertFalse(UIPasteboard.general.hasStrings)
    }

    @MainActor
    func testConnectionSetupLeadsWithAKeyAndChecksWhatsTyped() {
        let app = XCUIApplication()
        app.launchArguments.append("-FatlineIgnoreSavedAccount")
        app.launch()
        let start = app.buttons["welcome-continue"]
        XCTAssertTrue(start.waitForExistence(timeout: 5))
        let bottomOfContinue = start.frame.maxY
        attachScreenshot("Splash", app: app)
        start.tap()
        // Get started leads with Farcaster.
        let farcaster = app.buttons["setup-continue"]
        XCTAssertTrue(farcaster.waitForExistence(timeout: 5))
        farcaster.tap()

        XCTAssertTrue(app.staticTexts["Connect to Farcaster"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Paste your Neynar API key."].exists)
        XCTAssertTrue(app.secureTextFields["connection-field"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["connection-get-key"].exists)
        let submit = app.buttons["connection-continue"]
        XCTAssertFalse(submit.isEnabled)
        XCTAssertEqual(submit.frame.maxY, bottomOfContinue, accuracy: 1)
        attachScreenshot("Connection Key", app: app)

        app.buttons["connection-code"].tap()
        XCTAssertTrue(app.staticTexts["Use a code"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.textFields["connection-field"].exists)
        XCTAssertFalse(submit.isEnabled)
        attachScreenshot("Connection Code", app: app)
        let code = app.textFields["connection-field"]
        code.tap()
        // Return closes the keyboard, which would otherwise cover the next screen's buttons.
        code.typeText("abc@server.example\n")
        XCTAssertTrue(app.staticTexts["connection-invite-server"].waitForExistence(timeout: 5))
        XCTAssertTrue(submit.isEnabled)
        app.navigationBars.buttons.element(boundBy: 0).tap()

        let advanced = app.buttons["connection-custom"]
        XCTAssertTrue(advanced.waitForExistence(timeout: 5))
        advanced.tap()
        XCTAssertTrue(app.staticTexts["Connect your server"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["connection-setup-guide"].exists)
        attachScreenshot("Connection Server", app: app)
        let copy = app.buttons["connection-copy-prompt"]
        copy.tap()
        let copied = expectation(for: NSPredicate(format: "label CONTAINS 'Copied'"), evaluatedWith: copy)
        wait(for: [copied], timeout: 5)

        let address = app.textFields["connection-field"]
        address.tap()
        address.typeText("http://example.com")
        XCTAssertTrue(submit.isEnabled)
        submit.tap()
        XCTAssertTrue(app.staticTexts["connection-error"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["connection-error"].label, "Enter an HTTPS URL.")
        attachScreenshot("Connection Bad Address", app: app)
    }

    @MainActor
    private func attachScreenshot(_ name: String, app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

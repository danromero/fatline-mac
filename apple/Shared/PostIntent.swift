import AppIntents

/// Posts a cast from Shortcuts, Siri, or Spotlight, without opening the composer.
struct PostCastIntent: AppIntent {
    static let title: LocalizedStringResource = "Post to Farcaster"
    static let description = IntentDescription("Posts a cast from the account signed in to Fatline.")

    @Parameter(title: "Text", inputOptions: String.IntentInputOptions(multiline: true))
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Post \(\.$text) to Farcaster")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        // The session the app is showing, when there is one, so its feed gets the new cast.
        let session = PostingSession.current ?? PostingSession()
        do {
            try await session.postFromShortcut(text)
        } catch {
            throw PostIntentError(message: error.localizedDescription)
        }
        return .result(dialog: "Posted")
    }
}

/// Says why a shortcut couldn't post, in the app's own words.
struct PostIntentError: Error, CustomLocalizedStringResourceConvertible {
    let message: String
    var localizedStringResource: LocalizedStringResource { "\(message)" }
}

struct FatlineShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: PostCastIntent(),
            phrases: ["Post to Farcaster with \(.applicationName)", "Post a cast with \(.applicationName)"],
            shortTitle: "Post to Farcaster",
            systemImageName: "plus"
        )
    }
}

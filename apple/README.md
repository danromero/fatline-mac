# Fatline for Mac and iPhone

Both apps are SwiftUI and live in one Xcode project. Everything in [`Shared`](Shared) goes into both: the connection, the feed, signing, posting, drafts, and the styles. [`Mac`](Mac) and [`iPhone`](iPhone) hold each app's own windows and screens, and the unit tests in [`Tests`](Tests) run against both.

## Get it

**Mac.** [Download Fatline.dmg](https://github.com/danromero/fatline-monorepo/releases/latest/download/Fatline.dmg), open it, and drag Fatline to Applications. It needs macOS 27 or later, and it's signed and notarized, so it opens without a warning. When a new version is out, Fatline asks once, and if you say yes it replaces itself and restarts. It only installs a build signed by the same developer as the copy you're running. To find out, it asks GitHub for the latest release about once a day, which sends nothing about you beyond the usual web request.

**iPhone.** [Join the beta on TestFlight](https://testflight.apple.com/join/SnTSSbrE). It needs iOS 27 or later.

## Shortcuts

Both apps add a **Post to Farcaster** action to Shortcuts, Siri, and Spotlight. It takes text and posts it from the signed-in account.

## Menu bar

On the Mac, turn on **Show in menu bar** in Settings to keep Fatline a click away. The icon shows or hides the window, and a right-click has New Cast, Refresh, Settings, and Quit.

While it's on, Fatline checks the feed every ten minutes, and a small gold dot means someone has posted since you last looked. Closing the window hides it and Fatline keeps running. You can also turn off the Dock icon and have Fatline open at login.

## Build it

You need Xcode 27.2 and an Apple Developer account, because the apps keep their posting key in the Keychain, which needs a signed build. Everything below runs from this folder.

```bash
cp Signing.local.example.xcconfig Signing.local.xcconfig
```

Put your team ID and a bundle ID you own in that file. Git ignores it. Debug builds are called Fatline Dev and add `.dev` to the bundle ID, so they can sit next to a released copy with their own sign-in and drafts.

To build and open Fatline Dev on this Mac:

```bash
scripts/dev.sh
```

For iPhone, open `Fatline.xcodeproj`, choose the **iPhone** scheme and a device or simulator, and run.

A Debug build launched with `FATLINE_NEYNAR_KEY`, `FATLINE_INVITE`, or `FATLINE_SERVER_URL` in its environment uses that connection and skips the connection screen. In the Simulator, put `SIMCTL_CHILD_` in front of the name when running `xcrun simctl launch`.

## Test it

```bash
xcodebuild test -project Fatline.xcodeproj -scheme Mac -destination 'platform=macOS,arch=arm64'
```

For iPhone, replace `SIMULATOR_NAME` with an iOS 27 simulator from `xcrun simctl list devices`. This also runs the UI tests.

```bash
xcodebuild test -project Fatline.xcodeproj -scheme iPhone -destination 'platform=iOS Simulator,name=SIMULATOR_NAME'
```

## Release the Mac app

Distributing a build needs two things once:

1. A Developer ID Application certificate. In Xcode, open Settings, Apple Accounts, Manage Certificates, then add one. Only the team's Account Holder can.
2. A saved notary login, using an app-specific password from [account.apple.com](https://account.apple.com):

```bash
xcrun notarytool store-credentials fatline-notary --apple-id YOUR_APPLE_ID --team-id YOUR_TEAM_ID
```

Then, from a clean checkout:

```bash
scripts/release.sh
```

It runs the tests, signs, notarizes, and staples, then leaves `DerivedData.noindex/Release/Fatline.dmg` ready to attach to a GitHub release. Keep that filename, because the download link above depends on it. Tag the release `v` plus the Mac app's version, like `v0.3.0`, and make it the repository's latest release, because that's what tells people there's an update. A fork should point the two addresses in `Mac/UpdateCheck.swift` at its own repository.

The iPhone app ships through App Store Connect. Archive the **iPhone** scheme in Xcode and upload it from the Organizer.

## The recovery helper

`Shared/Recovery/authorize.js` is a bundled, offline copy of the signing code for the recovery phrase, run in a JavaScriptCore context with no network. [`recovery/build.sh`](../recovery/build.sh) at the top of the repository rebuilds it from pinned versions, and gives identical bytes.

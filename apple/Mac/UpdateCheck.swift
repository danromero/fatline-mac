import AppKit
import Security

/// Offers newer releases from GitHub. Saying yes downloads one, checks its signature, and replaces this copy.
/// Public builds offer each release once. Pilot builds, which carry `FatlinePilotFeed`, also check that feed,
/// ask again a day after Later, and have to update once a public release is newer than they are, so nobody
/// is left on a test build.
@MainActor
enum UpdateCheck {
    private static let latestRelease = URL(string: "https://api.github.com/repos/danromero/fatline-monorepo/releases/latest")!
    private static let publicDownload = URL(string: "https://github.com/danromero/fatline-monorepo/releases/latest/download/Fatline.dmg")!
    private static let announcedKey = "announcedUpdate"
    private static let snoozedKey = "pilotUpdateSnoozedUntil"
    private static var lastCheck = Date.distantPast

    /// Where a pilot build looks for newer pilot builds, with their `Fatline.dmg` beside it. Nil in public builds.
    static let pilotFeed: URL? = {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "FatlinePilotFeed") as? String,
              let url = URL(string: value), url.scheme == "https"
        else { return nil }
        return url
    }()

    /// GitHub's release answer, whose shape the pilot feed copies.
    private struct Release: Decodable {
        let tag_name: String
    }

    struct Offer: Equatable {
        let version: String
        /// Download from beside the pilot feed rather than from GitHub.
        let fromPilot: Bool
        /// A public release is newer than this pilot build, so the choices are Update or Quit.
        let required: Bool
    }

    private struct UpdateFailed: Error {}

    /// Called whenever the app comes forward as well as at launch, because people leave it open for days.
    static func runIfDue() {
        // Tests launch the app, and an alert would stop them.
        #if !DEBUG
        guard Date.now.timeIntervalSince(lastCheck) >= 24 * 60 * 60 else { return }
        lastCheck = .now
        Task { await run() }
        #endif
    }

    /// The newest version to offer, if any. Only pilot builds look at the pilot feed or have to update.
    nonisolated static func offer(current: String, publicVersion: String?, pilotVersion: String?, isPilot: Bool) -> Offer? {
        let newerPublic = publicVersion.flatMap { isNewer($0, than: current) ? $0 : nil }
        let newerPilot = isPilot ? pilotVersion.flatMap { isNewer($0, than: current) ? $0 : nil } : nil
        let required = isPilot && newerPublic != nil
        if let pilot = newerPilot, newerPublic.map({ isNewer(pilot, than: $0) }) ?? true {
            return Offer(version: pilot, fromPilot: true, required: required)
        }
        return newerPublic.map { Offer(version: $0, fromPilot: false, required: required) }
    }

    private static func run() async {
        guard let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String else { return }
        let publicVersion = await version(at: latestRelease)
        var pilotVersion: String?
        if let pilotFeed { pilotVersion = await version(at: pilotFeed) }
        guard let offer = offer(current: current, publicVersion: publicVersion, pilotVersion: pilotVersion, isPilot: pilotFeed != nil)
        else { return }

        let defaults = UserDefaults.standard
        if pilotFeed == nil {
            guard defaults.string(forKey: announcedKey) != offer.version else { return }
            defaults.set(offer.version, forKey: announcedKey)
        } else if !offer.required, let snoozed = defaults.object(forKey: snoozedKey) as? Date, snoozed > .now {
            return
        }

        let alert = NSAlert()
        if offer.required {
            alert.messageText = "This test build has ended"
            alert.informativeText = "Fatline \(offer.version) replaces it. Fatline will restart to update."
            alert.addButton(withTitle: "Update")
            alert.addButton(withTitle: "Quit")
        } else {
            alert.messageText = "Fatline \(offer.version) is available"
            alert.informativeText = "You have version \(current). Fatline will restart to update."
            alert.addButton(withTitle: "Update")
            alert.addButton(withTitle: "Later")
        }
        guard alert.runModal() == .alertFirstButtonReturn else {
            if offer.required {
                NSApp.terminate(nil)
            } else if pilotFeed != nil {
                defaults.set(Date.now.addingTimeInterval(24 * 60 * 60), forKey: snoozedKey)
            }
            return
        }

        let source = offer.fromPilot ? pilotFeed!.deletingLastPathComponent().appending(path: "Fatline.dmg") : publicDownload
        do {
            let app = Bundle.main.bundleURL
            try await install(from: source, over: app, current: current)
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.createsNewApplicationInstance = true
            _ = try await NSWorkspace.shared.openApplication(at: app, configuration: configuration)
            NSApp.terminate(nil)
        } catch {
            // A copy that can't be replaced, like one running from the disk image, can still be updated by hand.
            NSWorkspace.shared.open(source)
            let failed = NSAlert()
            failed.messageText = "Fatline couldn’t update itself"
            failed.informativeText = "Open the Fatline.dmg that’s downloading, and drag Fatline to Applications."
            failed.runModal()
        }
    }

    private static func version(at url: URL) async -> String? {
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let release = try? JSONDecoder().decode(Release.self, from: data)
        else { return nil }
        return String(release.tag_name.trimmingPrefix("v"))
    }

    nonisolated static func isNewer(_ latest: String, than current: String) -> Bool {
        latest.compare(current, options: .numeric) == .orderedDescending
    }

    @concurrent
    nonisolated private static func install(from source: URL, over app: URL, current: String) async throws {
        let (dmg, _) = try await URLSession.shared.download(from: source)
        let files = FileManager.default
        // On the app's own volume, so the final swap is a rename.
        let work = try files.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: app, create: true)
        defer {
            try? files.removeItem(at: work)
            try? files.removeItem(at: dmg)
        }

        let staged = work.appending(path: "Fatline.app")
        try copyApp(fromDiskImage: dmg, mountingAt: work.appending(path: "mount"), to: staged)

        try requireSameSigner(staged)
        guard let version = Bundle(url: staged)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              isNewer(version, than: current)
        else { throw UpdateFailed() }

        _ = try files.replaceItemAt(app, withItemAt: staged)
    }

    /// Uses diskutil, because hdiutil's attach and detach print deprecation warnings on macOS 27.
    nonisolated static func copyApp(fromDiskImage image: URL, mountingAt mount: URL, to destination: URL) throws {
        try runTool("/usr/sbin/diskutil", "image", "attach", "--readOnly", "--nobrowse", "--mountPoint", mount.path, image.path)
        defer { try? runTool("/usr/sbin/diskutil", "eject", "force", mount.path) }
        try runTool("/usr/bin/ditto", mount.appending(path: "Fatline.app").path, destination.path)
    }

    /// The real check on what was downloaded: it has to satisfy the signing requirement of the running app.
    nonisolated private static func requireSameSigner(_ candidate: URL) throws {
        var running: SecCode?
        var mine: SecStaticCode?
        var requirement: SecRequirement?
        var code: SecStaticCode?
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
        guard SecCodeCopySelf([], &running) == errSecSuccess, let running,
              SecCodeCopyStaticCode(running, [], &mine) == errSecSuccess, let mine,
              SecCodeCopyDesignatedRequirement(mine, [], &requirement) == errSecSuccess,
              SecStaticCodeCreateWithPath(candidate as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess
        else { throw UpdateFailed() }
    }

    nonisolated private static func runTool(_ path: String, _ arguments: String...) throws {
        let process = Process()
        process.executableURL = URL(filePath: path)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw UpdateFailed() }
    }
}

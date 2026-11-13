import Foundation

/// The network composer's draft, kept per network, so what was written for one network never shows in
/// another. Only the text is kept, as in the Farcaster composer.
enum NetworkDrafts {
    /// `Network Drafts/<host>` in the app folder, apart for each dev profile like other saved state.
    static func store(for host: String, in folder: URL = Platform.appFolder) -> DraftStore {
        DraftStore(directory: folder
            .appending(path: "Network Drafts" + DevProfile.suffix, directoryHint: .isDirectory)
            .appending(path: folderName(host), directoryHint: .isDirectory))
    }

    /// The host as one folder name: anything but letters, digits, and the punctuation of a host and port
    /// becomes `_`, so no host can name a folder outside its own.
    static func folderName(_ host: String) -> String {
        let name = String(host.map { $0.isASCII && ($0.isLetter || $0.isNumber || ".-:[]".contains($0)) ? $0 : "_" })
        return name.isEmpty || name.allSatisfy({ $0 == "." }) ? "_" + name : name
    }
}

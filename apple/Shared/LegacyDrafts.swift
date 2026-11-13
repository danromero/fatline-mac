import Foundation

extension DraftStore {
    /// Moves a draft saved before drafts were kept per account. Only early iPhone builds left any.
    func adoptLegacy(from legacy: Self) throws {
        let manager = FileManager.default
        guard manager.fileExists(atPath: legacy.current.path) || manager.fileExists(atPath: legacy.backup.path) else { return }
        let marker = legacy.directory.appending(path: "draft-account")
        let destinationAccount = directory.lastPathComponent
        if manager.fileExists(atPath: marker.path) {
            guard try String(contentsOf: marker, encoding: .utf8) == destinationAccount else { return }
        } else {
            try destinationAccount.write(to: marker, atomically: true, encoding: .utf8)
        }
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        for (source, destination) in [(legacy.backup, backup), (legacy.current, current)] {
            if manager.fileExists(atPath: source.path), !manager.fileExists(atPath: destination.path) {
                try manager.moveItem(at: source, to: destination)
            }
        }
    }
}

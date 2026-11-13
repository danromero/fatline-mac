import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Writing a post in a network: up to 280 characters and two attachments. Pictures come from Add
/// Image, pasting, or dropping. A link in the text becomes a card, which the post carries as its link
/// while there's room, until the card's × takes it off.
struct NetworkComposerSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var images: [NetworkImage] = []
    @State private var removedLinks: Set<URL> = []
    @State private var preview: LinkPreview?
    @State private var sending = false
    @State private var failure: String?
    @State private var choosing = false
    @State private var dropping = false
    @State private var pasteMonitor: Any?
    /// The network the sheet opened on, which the post goes to whatever is showing later.
    @State private var host: String?
    @FocusState private var focused: Bool

    private var destination: NetworkMembership? { state.networks.memberships.first { $0.host == host } }

    private var count: Int { NetworkMessages.characterCount(text) }
    /// The link card shows while there's room for it beside the pictures.
    private var link: URL? {
        guard images.count < NetworkMessages.maxEmbeds else { return nil }
        return LinkPreview.firstLink(in: text).flatMap { removedLinks.contains($0) ? nil : $0 }
    }
    private var roomForImages: Int { NetworkMessages.maxEmbeds - images.count - (link == nil ? 0 : 1) }
    private var canSend: Bool {
        !sending && host != nil && count <= NetworkMessages.maxCharacters
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty)
    }

    /// Pictures in the composer are square thumbnails, and a link card beside one matches its height.
    private static let thumbnailSide: CGFloat = 128 // layout-ok: the canvas's attachment size

    /// The editor's height. The sheet grows by the card and any error under it.
    private static let editorHeight: CGFloat = 172 // layout-ok: makes the sheet 240 without a card

    var body: some View {
        VStack(spacing: 0) {
            TextEditor(text: $text)
                .font(FatlineStyle.body)
                .lineSpacing(FatlineStyle.bodyLineSpacing)
                .scrollContentBackground(.hidden)
                .scrollIndicators(.never)
                .focused($focused)
                .frame(height: Self.editorHeight)
                .accessibilityLabel("Post")
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Write a post…")
                            .font(FatlineStyle.body)
                            .foregroundStyle(FatlineStyle.secondary)
                            .padding(.leading, 5) // layout-ok: the editor's own text inset
                            .allowsHitTesting(false)
                    }
                }
                // The editor insets its text by 5, so the text itself sits on the 20-point margin.
                .padding(.horizontal, 15) // layout-ok: 20 less the editor's inset, as in the Farcaster composer
                .padding(.top, 18) // layout-ok: as in the Farcaster composer
            if !images.isEmpty || link != nil {
                attachments
                    .padding(.horizontal, 20) // layout-ok: the composer's leading margin
                    .padding(.top, FatlineStyle.groupGap)
                    .padding(.bottom, FatlineStyle.gutter)
            }
            if let failure {
                Text(failure)
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20) // layout-ok: the composer's leading margin
                    .padding(.bottom, FatlineStyle.itemGap)
            }
            FatlineDivider()
            HStack(spacing: FatlineStyle.groupGap) {
                Button { choosing = true } label: {
                    Image(systemName: "photo")
                        .font(.system(size: 16)) // layout-ok: an 18-point glyph in a 30-point button, as on the canvas
                        .foregroundStyle(roomForImages > 0 ? FatlineStyle.secondary : FatlineStyle.outline)
                        .frame(width: FatlineStyle.compactButtonHeight, height: FatlineStyle.compactButtonHeight)
                        .contentShape(.rect)
                }
                .disabled(roomForImages == 0 || sending)
                .help(roomForImages > 0 ? "Add Image" : "Two attachments is the limit")
                .accessibilityLabel(roomForImages > 0 ? "Add Image" : "Add Image, two is the limit")
                // Where the post goes, named, since the sheet doesn't follow the title menu.
                if let destination {
                    Text("To \(destination.title)")
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .help(destination.host)
                        .accessibilityLabel("Posting to \(destination.label)")
                }
                if count >= NetworkMessages.maxCharacters - 30 {
                    Text("\(count) / \(NetworkMessages.maxCharacters)")
                        .font(FatlineStyle.meta)
                        .monospacedDigit()
                        .foregroundStyle(count > NetworkMessages.maxCharacters ? FatlineStyle.danger : FatlineStyle.secondary)
                        .accessibilityLabel("\(count) of \(NetworkMessages.maxCharacters) characters")
                }
                Spacer(minLength: FatlineStyle.itemGap)
                Button("Cancel") { dismiss() }
                    .font(FatlineStyle.body)
                    .keyboardShortcut(.cancelAction)
                    .disabled(sending)
                Button(sending ? "Posting…" : "Post") { send() }
                    .buttonStyle(FatlinePrimaryButton(compact: true, minWidth: 68, isWorking: sending)) // layout-ok: the composer's Post width
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSend)
            }
            .buttonStyle(.plain)
            .frame(height: 48) // layout-ok: the composer footer
            // The picture glyph is 18 wide in a 30-point button, so 14 here puts it on the 20-point margin.
            .padding(.leading, 14) // layout-ok: see above
            .padding(.trailing, 10) // layout-ok: puts Post's edge where the sheet's corner curve allows
        }
        .frame(width: 400) // layout-ok: the composer width
        .fixedSize(horizontal: false, vertical: true)
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper)
        .overlay {
            if dropping {
                RoundedRectangle(cornerRadius: FatlineStyle.fieldRadius, style: .continuous)
                    .strokeBorder(FatlineStyle.action, lineWidth: 2)
                    .allowsHitTesting(false)
            }
        }
        .tint(FatlineStyle.action)
        .onAppear {
            if host == nil { host = state.networks.selectedHost }
            focused = true
            pasteMonitor = watchPaste()
        }
        .onDisappear {
            if let pasteMonitor { NSEvent.removeMonitor(pasteMonitor) }
        }
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { attach(urls.compactMap(Self.image(at:))) }
        }
        .onDrop(of: [.fileURL, .image], isTargeted: $dropping) { providers in
            Task { attach(await Self.images(from: providers)) }
            return roomForImages > 0
        }
    }

    /// Pictures, then the link card while there's room: a full-width card on its own, or one as tall as
    /// a picture beside it.
    private var attachments: some View {
        HStack(alignment: .top, spacing: FatlineStyle.itemGap) {
            ForEach(images) { image in
                Image(decorative: image.thumbnail, scale: 1)
                    .resizable()
                    .interpolation(.high)
                    .scaledToFill()
                    .frame(width: Self.thumbnailSide, height: Self.thumbnailSide)
                    .clipShape(.rect(cornerRadius: FatlineStyle.cardRadius, style: .continuous))
                    .overlay(alignment: .topTrailing) {
                        RemoveButton(label: "Remove image") { images.removeAll { $0.id == image.id } }
                    }
            }
            if let link {
                LinkCard(url: link, preview: preview, height: images.isEmpty ? nil : Self.thumbnailSide) { removedLinks.insert(link) }
                    .task(id: link) {
                        preview = nil
                        preview = await LinkPreview.load(link)
                    }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func attach(_ added: [NetworkImage]) {
        let room = roomForImages
        guard room > 0, !added.isEmpty else {
            if !added.isEmpty { failure = "A post can have two attachments." }
            return
        }
        images.append(contentsOf: added.prefix(room))
        failure = added.count > room ? "A post can have two attachments." : nil
    }

    /// ⌘V with a picture on the clipboard and no text attaches the picture. Text pastes as usual.
    private func watchPaste() -> Any? {
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers == "v", let found = Self.pastedImages(), !found.isEmpty else { return event }
            attach(found)
            return nil
        }
    }

    private static func pastedImages() -> [NetworkImage]? {
        let board = NSPasteboard.general
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            let found = urls.compactMap(image(at:))
            return found.isEmpty ? nil : found
        }
        guard board.string(forType: .string) == nil else { return nil }
        for type in [NSPasteboard.PasteboardType.png, .tiff, NSPasteboard.PasteboardType("public.jpeg"), NSPasteboard.PasteboardType("public.heic")] {
            if let data = board.data(forType: type), let image = NetworkImage(data: data) { return [image] }
        }
        return nil
    }

    private static func image(at url: URL) -> NetworkImage? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return NetworkImage(contentsOf: url)
    }

    private static func images(from providers: [NSItemProvider]) async -> [NetworkImage] {
        var found: [NetworkImage] = []
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier),
               let item = try? await provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier),
               let url = (item as? Data).flatMap({ URL(dataRepresentation: $0, relativeTo: nil) }) ?? (item as? URL),
               let image = image(at: url) {
                found.append(image)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
                      let data = await withCheckedContinuation({ (done: CheckedContinuation<Data?, Never>) in
                          _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in done.resume(returning: data) }
                      }),
                      let image = NetworkImage(data: data) {
                found.append(image)
            }
        }
        return found
    }

    private func send() {
        guard canSend, let host else { return }
        sending = true
        failure = nil
        Task {
            do {
                try await state.networks.post(to: host, text: text, link: link?.absoluteString, images: images)
                dismiss()
            } catch {
                failure = error.localizedDescription
            }
            sending = false
        }
    }
}

/// A link's title, description, and site, with × to keep the link as plain text. Beside a picture it
/// takes the picture's height, with the site at the bottom.
private struct LinkCard: View {
    let url: URL
    let preview: LinkPreview?
    var height: CGFloat?
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) { // layout-ok: a title and its line read as one
            Text(verbatim: preview?.title ?? FeedCast.label(for: url))
                .font(FatlineStyle.bodyStrong)
                .lineLimit(height == nil ? 1 : 2)
            if let description = preview?.description {
                Text(verbatim: description)
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.secondary)
                    .lineLimit(height == nil ? 1 : 2)
            }
            if height != nil { Spacer(minLength: 0) }
            Text(verbatim: url.host() ?? url.absoluteString)
                .font(FatlineStyle.meta)
                .foregroundStyle(FatlineStyle.secondary)
                .lineLimit(1)
                .padding(.top, FatlineStyle.castGap)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(FatlineStyle.groupGap)
        .padding(.trailing, FatlineStyle.textColumn - FatlineStyle.gutter - FatlineStyle.groupGap) // layout-ok: clears the × button
        .frame(height: height)
        .background(FatlineStyle.quiet, in: .rect(cornerRadius: FatlineStyle.cardRadius, style: .continuous))
        .overlay(alignment: .topTrailing) { RemoveButton(label: "Remove link preview", action: remove) }
        .accessibilityElement(children: .contain)
    }
}

/// The × on an attachment.
private struct RemoveButton: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 8, weight: .bold)) // layout-ok: the glyph in a 22-point close button
                .foregroundStyle(FatlineStyle.paper)
                .frame(width: 22, height: 22) // layout-ok: a close button inside a card
                .background(FatlineStyle.ink.opacity(0.72), in: .circle)
        }
        .buttonStyle(.plain)
        .padding(6) // layout-ok: concentric with the card's 10-point corner
        .accessibilityLabel(label)
    }
}

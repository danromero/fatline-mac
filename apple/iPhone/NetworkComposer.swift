import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Writing a post in a network, as a sheet over its feed: up to 280 characters and two attachments.
/// A link in the text becomes a card, which the post carries as its link while there's room, until the
/// card's × takes it off and leaves the link as plain text. The sheet posts to the network it opened
/// on, and names it, so a post can't land in another network by mistake. Its text is kept per network
/// until the post is in.
struct NetworkComposer: View {
    let host: String

    @Environment(NetworkModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var text = ""
    @State private var images: [NetworkImage] = []
    @State private var removedLinks: Set<URL> = []
    /// The link card's title and description, with the link they were read for.
    @State private var preview: (link: URL, read: LinkPreview?)?
    @State private var sending = false
    @State private var failure: String?
    @State private var choosing = false
    @State private var picked: [PhotosPickerItem] = []
    /// The clipboard holds a picture, so Add Image offers Paste Picture. Asking doesn't read it.
    @State private var canPaste = UIPasteboard.general.hasImages
    /// The saved draft has been read, so saving won't write over it.
    @State private var loaded = false
    /// The post is in, so closing doesn't save its text again.
    @State private var posted = false
    @FocusState private var focused: Bool

    /// The network's mark in the header.
    private static let markSize: CGFloat = 20 // layout-ok: the mark beside a 16-point title, as on the canvas

    private var destination: NetworkMembership? { model.memberships.first { $0.host == host } }
    private var drafts: DraftStore { NetworkDrafts.store(for: host) }
    private var count: Int { NetworkMessages.characterCount(text) }
    private var over: Bool { count > NetworkMessages.maxCharacters }
    /// The link card shows while there's room for it beside the pictures.
    private var link: URL? {
        guard images.count < NetworkMessages.maxEmbeds else { return nil }
        return LinkPreview.firstLink(in: text).flatMap { removedLinks.contains($0) ? nil : $0 }
    }
    private var roomForImages: Int { NetworkMessages.maxEmbeds - images.count - (link == nil ? 0 : 1) }
    private var canSend: Bool {
        !sending && destination != nil && !over
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    TextField("Post", text: $text, prompt: Text("Write a post…").foregroundStyle(FatlineStyle.secondary), axis: .vertical)
                        .font(FatlineStyle.body)
                        .lineSpacing(FatlineStyle.bodyLineSpacing)
                        .focused($focused)
                        .accessibilityIdentifier("network-post-text")
                    if !images.isEmpty || link != nil {
                        attachments.padding(.top, FatlineStyle.gutter)
                    }
                    if let failure {
                        Text(failure)
                            .font(FatlineStyle.meta)
                            .foregroundStyle(FatlineStyle.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, FatlineStyle.itemGap)
                    }
                }
                .padding(.horizontal, FatlineStyle.gutter)
                .padding(.top, FatlineStyle.itemGap)
                .padding(.bottom, FatlineStyle.gutter)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            // A tap anywhere under the text goes to the text.
            .background {
                Color.clear
                    .contentShape(.rect)
                    .onTapGesture { focused = true }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { bar }
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .interactiveDismissDisabled(sending)
        .task {
            if !loaded {
                text = (try? drafts.load()) ?? ""
                loaded = true
            }
            focused = true
        }
        .task(id: text) {
            // A change to the text cancels this wait, so a save happens once typing pauses.
            do { try await Task.sleep(for: .seconds(0.5)) } catch { return }
            saveDraft()
        }
        // Swiping the sheet down keeps the draft, as Cancel does.
        .onDisappear(perform: saveDraft)
        // One tick on going over the limit, the moment Post turns off.
        .onChange(of: over) { _, over in
            if over { Platform.haptic(.pick) }
        }
        .photosPicker(isPresented: $choosing, selection: $picked, maxSelectionCount: max(roomForImages, 1),
                      selectionBehavior: .ordered, matching: .images, preferredItemEncoding: .current)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { attach(await Self.images(from: items)) }
        }
        // Copying in this app or another one changes what Add Image offers.
        .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) { _ in
            canPaste = UIPasteboard.general.hasImages
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { canPaste = UIPasteboard.general.hasImages }
        }
    }

    /// Cancel on the gutter, where the post goes in the middle, and Post on the trailing gutter.
    private var header: some View {
        HStack(spacing: FatlineStyle.itemGap) {
            Button("Cancel", action: cancel)
                .font(FatlineStyle.body)
                .frame(minHeight: FatlineStyle.buttonHitHeight)
                .disabled(sending)
                .fixedSize()
                .frame(maxWidth: .infinity, alignment: .leading)
            if let destination {
                HStack(spacing: FatlineStyle.itemGap) {
                    NetworkMark(name: destination.title, icon: destination.icon, size: Self.markSize)
                    Text(verbatim: destination.title)
                        .font(FatlineStyle.bodyStrong)
                        .lineLimit(1)
                }
                .layoutPriority(1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Posting to \(destination.label)")
            }
            Button(sending ? "Posting…" : "Post", action: send)
                .buttonStyle(FatlinePrimaryButton(compact: true, minWidth: FatlineStyle.postPillWidth, isWorking: sending))
                .disabled(!canSend)
                .accessibilityIdentifier("network-post")
                .fixedSize()
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(.horizontal, FatlineStyle.gutter)
        .frame(minHeight: FatlineStyle.sheetHeaderHeight)
        // Like the feed's title, it stops growing before the network's name has no room left.
        .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
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
                    .frame(width: FatlineStyle.attachmentSide, height: FatlineStyle.attachmentSide)
                    .clipShape(.rect(cornerRadius: FatlineStyle.cardRadius, style: .continuous))
                    .accessibilityElement()
                    .accessibilityLabel("Picture")
                    .overlay(alignment: .topTrailing) {
                        RemoveAttachmentButton(label: "Remove picture") {
                            images.removeAll { $0.id == image.id }
                            failure = nil
                        }
                    }
            }
            if let link {
                ComposerLinkCard(url: link, preview: preview?.link == link ? preview?.read : nil, beside: !images.isEmpty) {
                    removedLinks.insert(link)
                }
                .task(id: link) {
                    // Typing changes the link letter by letter, so a page read for an earlier one is dropped.
                    let read = await LinkPreview.load(link)
                    if !Task.isCancelled { preview = (link, read) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Add Image on the gutter, and from 250 characters the count on the trailing gutter.
    private var bar: some View {
        VStack(spacing: 0) {
            FatlineDivider()
            HStack(spacing: FatlineStyle.itemGap) {
                Menu {
                    Button("Photo Library", systemImage: "photo.on.rectangle") { choosing = true }
                    if canPaste {
                        Button("Paste Picture", systemImage: "doc.on.clipboard", action: paste)
                    }
                } label: {
                    Image(systemName: "photo")
                        .font(.system(size: FatlineStyle.bodySize)) // layout-ok: a 20-point glyph standing alone, as on the canvas
                        .foregroundStyle(roomForImages > 0 ? FatlineStyle.secondary : FatlineStyle.outline)
                        .frame(width: FatlineStyle.buttonHitHeight, height: FatlineStyle.buttonHitHeight)
                        .contentShape(.rect)
                }
                .menuStyle(.button)
                // Photo Library first, read from the top, wherever the menu opens.
                .menuOrder(.fixed)
                .buttonStyle(.plain)

                .disabled(roomForImages == 0 || sending)
                .accessibilityLabel(roomForImages > 0 ? "Add Image" : "Add Image, two attachments is the limit")
                .accessibilityIdentifier("network-add-image")
                Spacer(minLength: FatlineStyle.itemGap)
                if count >= NetworkMessages.maxCharacters - 30 {
                    Text("\(count) / \(NetworkMessages.maxCharacters)")
                        .font(FatlineStyle.meta)
                        .monospacedDigit()
                        .foregroundStyle(over ? FatlineStyle.danger : FatlineStyle.secondary)
                        .accessibilityLabel("\(count) of \(NetworkMessages.maxCharacters) characters")
                }
            }
            // The glyph is 20 wide in its 44-point target, so it sits on the gutter.
            .padding(.leading, FatlineStyle.gutter - FatlineStyle.groupGap)
            .padding(.trailing, FatlineStyle.gutter)
            .frame(minHeight: FatlineStyle.sheetBarHeight)
        }
        .background(FatlineStyle.paper)
    }

    /// Nothing comes back when the picture can't be read, or when Don't Allow answered iOS's question.
    private func paste() {
        Task {
            let pasted = await Self.pastedImages()
            if pasted.isEmpty {
                failure = "Couldn’t paste the picture."
            } else {
                attach(pasted)
            }
        }
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

    /// Each picked picture, read as it is and made ready for the network away from the main thread.
    /// Your profile's Change Picture uses it too.
    static func images(from items: [PhotosPickerItem]) async -> [NetworkImage] {
        var found: [NetworkImage] = []
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self), let image = await prepare(data) else { continue }
            found.append(image)
        }
        return found
    }

    /// The pictures on the clipboard, each read in its own format where it has one, so a moving GIF
    /// keeps its frames. iOS asks before the first paste from another app, as for any paste.
    private static func pastedImages() async -> [NetworkImage] {
        let preferred = [UTType.gif, .png, .jpeg, .heic, .webP, .tiff].map(\.identifier)
        var found: [NetworkImage] = []
        for item in UIPasteboard.general.items.prefix(NetworkMessages.maxEmbeds) {
            let data = preferred.lazy.compactMap { type -> Data? in
                switch item[type] {
                case let data as Data: data
                case let image as UIImage: image.pngData()
                default: nil
                }
            }.first ?? item.values.lazy.compactMap { ($0 as? UIImage)?.pngData() }.first
            if let data, let image = await prepare(data) { found.append(image) }
        }
        return found
    }

    @concurrent private static func prepare(_ data: Data) async -> NetworkImage? {
        NetworkImage(data: data)
    }

    private func cancel() {
        saveDraft()
        dismiss()
    }

    private func saveDraft() {
        guard loaded, !posted else { return }
        try? drafts.save(text)
    }

    private func send() {
        guard canSend else { return }
        Platform.haptic(.tap)
        sending = true
        failure = nil
        Task {
            do {
                try await model.post(to: host, text: text, link: link?.absoluteString, images: images)
                posted = true
                try? drafts.save("")
                Platform.haptic(.done)
                dismiss()
            } catch {
                Platform.haptic(.problem)
                failure = error.localizedDescription
            }
            sending = false
        }
    }
}

/// A link's title, description, and site, with × to keep the link as plain text. Beside a picture it
/// takes the picture's height, with two lines each and the site at the bottom.
private struct ComposerLinkCard: View {
    let url: URL
    let preview: LinkPreview?
    let beside: Bool
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) { // layout-ok: a title and its line read as one
            Text(verbatim: preview?.title ?? FeedCast.label(for: url))
                .font(FatlineStyle.bodyStrong)
                .lineLimit(beside ? 2 : 1)
            if let description = preview?.description {
                Text(verbatim: description)
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.secondary)
                    .lineLimit(beside ? 2 : 1)
            }
            if beside { Spacer(minLength: 0) }
            Text(verbatim: url.host() ?? url.absoluteString)
                .font(FatlineStyle.meta)
                .foregroundStyle(FatlineStyle.secondary)
                .lineLimit(1)
                .padding(.top, beside ? 0 : FatlineStyle.castGap)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(FatlineStyle.groupGap)
        // Clears the × in its 44-point target.
        .padding(.trailing, FatlineStyle.buttonHitHeight - FatlineStyle.groupGap)
        .frame(height: beside ? FatlineStyle.attachmentSide : nil)
        .background(FatlineStyle.quiet, in: .rect(cornerRadius: FatlineStyle.cardRadius, style: .continuous))
        .accessibilityElement(children: .combine)
        .overlay(alignment: .topTrailing) { RemoveAttachmentButton(label: "Remove link preview", action: remove) }
    }
}

/// The × on an attachment: a small dark circle in a 44-point target at the corner.
private struct RemoveAttachmentButton: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold)) // layout-ok: the glyph in the 24-point circle, as on the canvas
                .foregroundStyle(FatlineStyle.paper)
                .frame(width: FatlineStyle.removeButtonSize, height: FatlineStyle.removeButtonSize)
                .background(FatlineStyle.ink.opacity(0.72), in: .circle)
                .frame(width: FatlineStyle.buttonHitHeight, height: FatlineStyle.buttonHitHeight)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

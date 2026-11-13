import PhotosUI
import SwiftUI

/// Your picture, name, and bio in the network that's showing, pushed in Settings, from the Your
/// profile artboard. A new picture applies at once; Save keeps the name and bio.
struct NetworkProfileView: View {
    @Environment(NetworkModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var bio = ""
    @State private var saving = false
    @State private var changingPicture = false
    @State private var picked: PhotosPickerItem?
    @State private var error: String?
    @State private var avatar: CGImage?

    private static let maxName = 32
    private static let maxBio = 160

    private var valid: Bool { name.count <= Self.maxName && bio.count <= Self.maxBio }
    private var ownAvatar: Bool { model.you?.ownAvatar ?? false }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Profile").fatlineScreenTitle()
                HStack(spacing: FatlineStyle.groupGap) {
                    picture
                    VStack(alignment: .leading, spacing: FatlineStyle.castGap) {
                        let pictureTitle = changingPicture ? "Changing…" : "Change Picture"
                        PhotosPicker(selection: $picked, matching: .images, preferredItemEncoding: .current) {
                            Text(pictureTitle)
                        }
                        .buttonStyle(FatlineOutlineButton())
                        .disabled(changingPicture)
                        if ownAvatar {
                            Button("Use Farcaster Picture") { change(to: nil) }
                                .buttonStyle(.plain)
                                .font(FatlineStyle.meta)
                                .foregroundStyle(FatlineStyle.ink)
                                .frame(minHeight: FatlineStyle.buttonHitHeight)
                                .disabled(changingPicture)
                        }
                    }
                }
                .padding(.top, FatlineStyle.gutter)
                label("Name").padding(.top, FatlineStyle.gutter + FatlineStyle.itemGap)
                field("Name", text: $name, limit: Self.maxName).padding(.top, FatlineStyle.itemGap)
                label("Bio").padding(.top, FatlineStyle.gutter)
                field("Bio", text: $bio, limit: Self.maxBio, lines: 3).padding(.top, FatlineStyle.itemGap)
                HStack(alignment: .firstTextBaseline, spacing: FatlineStyle.itemGap) {
                    Text(verbatim: model.you?.username ?? "").font(FatlineStyle.bodyStrong)
                    Spacer(minLength: FatlineStyle.itemGap)
                    Text("From Farcaster")
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.secondary)
                }
                .padding(.top, FatlineStyle.gutter + FatlineStyle.itemGap)
                if let error {
                    Text(error)
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, FatlineStyle.itemGap)
                }
            }
            .padding(.horizontal, FatlineStyle.gutter)
            .padding(.top, FatlineStyle.screenTop)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .fatlineBottomAction(gutter: FatlineStyle.gutter) {
            Button(action: save) {
                Text(saving ? "Saving…" : "Save").frame(maxWidth: .infinity)
            }
            .buttonStyle(FatlinePrimaryButton(isWorking: saving))
            .disabled(saving || !valid)
            .accessibilityIdentifier("network-profile-save")
        }
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        // The title is in the content, as on the setup steps.
        .fatlineStepBar()
        .onAppear {
            name = model.you?.displayName ?? ""
            bio = model.you?.bio ?? ""
        }
        .task(id: model.you?.avatar) { await loadAvatar() }
        .onChange(of: picked) { _, item in
            guard let item else { return }
            picked = nil
            Task {
                guard let image = await NetworkComposer.images(from: [item]).first else {
                    error = "That isn’t a picture Fatline can read."
                    return
                }
                change(to: image)
            }
        }
    }

    /// The picture, or initials until there is one.
    private var picture: some View {
        ZStack {
            Circle().fill(FatlineStyle.quiet)
            if let avatar {
                Image(decorative: avatar, scale: 1).resizable().interpolation(.high).scaledToFill()
            } else {
                Text(String((model.you?.username ?? "").filter(\.isLetter).prefix(2)).uppercased())
                    .font(FatlineStyle.bodyStrong)
                    .foregroundStyle(FatlineStyle.secondary)
            }
            if changingPicture { ProgressView().controlSize(.small) }
        }
        .frame(width: FatlineStyle.profilePictureSize, height: FatlineStyle.profilePictureSize)
        .clipShape(.circle)
        .accessibilityHidden(true)
    }

    private func label(_ text: String) -> some View {
        Text(text)
            .font(FatlineStyle.metaStrong)
            .foregroundStyle(FatlineStyle.secondary)
    }

    private func field(_ title: String, text: Binding<String>, limit: Int, lines: Int = 1) -> some View {
        TextField(title, text: text, axis: .vertical)
            .lineLimit(lines...lines + 2)
            .font(FatlineStyle.body)
            .padding(.horizontal, FatlineStyle.fieldInset)
            .padding(.vertical, FatlineStyle.groupGap)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(FatlineStyle.quiet, in: .rect(cornerRadius: FatlineStyle.fieldRadius, style: .continuous))
            .overlay(alignment: .bottomTrailing) {
                if text.wrappedValue.count > limit - 10 {
                    Text("\(text.wrappedValue.count) / \(limit)")
                        .font(FatlineStyle.meta)
                        .monospacedDigit()
                        .foregroundStyle(text.wrappedValue.count > limit ? FatlineStyle.danger : FatlineStyle.secondary)
                        .padding(.horizontal, FatlineStyle.fieldInset)
                        .padding(.vertical, FatlineStyle.groupGap)
                }
            }
            .accessibilityLabel(title)
    }

    private func loadAvatar() async {
        guard let link = model.you?.avatar, let host = model.selectedHost, let url = FeedCast.networkMediaURL(link, host: host) else {
            avatar = nil
            return
        }
        avatar = await CastImages.load(url, maxPixels: 192)
    }

    /// Uploads a new picture, or with nil goes back to the Farcaster one.
    private func change(to image: NetworkImage?) {
        changingPicture = true
        error = nil
        if let image { avatar = image.thumbnail }
        Task {
            do { try await model.setAvatar(image) } catch { self.error = error.localizedDescription }
            changingPicture = false
        }
    }

    private func save() {
        Platform.haptic(.tap)
        saving = true
        error = nil
        Task {
            do {
                try await model.updateProfile(displayName: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                              bio: bio.trimmingCharacters(in: .whitespacesAndNewlines))
                Platform.haptic(.done)
                model.toast = "Saved"
                dismiss()
            } catch {
                Platform.haptic(.problem)
                self.error = error.localizedDescription
            }
            saving = false
        }
    }
}

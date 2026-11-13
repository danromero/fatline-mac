import SwiftUI

/// Settings while a network shows: you there, your profile, its members, managing it if you're an
/// admin, the app's switches, and leaving. It follows the Farcaster Settings row for row.
struct NetworkSettingsStack: View {
    let membership: NetworkMembership

    @Environment(AppState.self) private var state
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var confirmingLeave = false
    @State private var waiting: Int?

    private var model: NetworkModel { state.networks }
    private var approved: Bool { membership.status == .approved }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                FatlineDivider()
                ScrollView {
                    VStack(spacing: 0) {
                        SettingsAccountRow(handle: model.you?.handle ?? model.handle(for: membership.fid)) {
                            HStack(spacing: FatlineStyle.actionIconGap) {
                                NetworkMark(name: membership.title, icon: membership.icon, size: FatlineStyle.gutter)
                                Text(verbatim: membership.label)
                            }
                            .font(FatlineStyle.meta)
                            .foregroundStyle(FatlineStyle.secondary)
                        }
                        CastDivider()
                        if approved {
                            NavigationLink { NetworkProfileView(membership: membership) } label: { SettingsRow(title: "Profile") }
                                .buttonStyle(.plain)
                            CastDivider()
                            NavigationLink { NetworkMembersView() } label: {
                                SettingsRow(title: "Members", value: model.members.isEmpty ? nil : "\(model.members.count)")
                            }
                            .buttonStyle(.plain)
                            CastDivider()
                            if membership.isAdmin {
                                Button(action: state.manageNetwork) {
                                    SettingsRow(title: "Manage Network", value: waiting.flatMap(Self.requests), symbol: "arrow.up.right")
                                }
                                .buttonStyle(.plain)
                                .help("Opens the admin pages in your browser")
                                CastDivider()
                            }
                        }
                        AppSwitches()
                        SettingsVersion()
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 0) {
                        CastDivider()
                        SettingsDangerButton(title: approved ? "Leave \(membership.title)" : "Remove from This Mac") { confirmingLeave = true }
                    }
                    .padding(.bottom, FatlineStyle.itemGap)
                    .background(FatlineStyle.paper)
                }
            }
            .background(FatlineStyle.paper)
            .navigationTitle("Settings")
            .settingsTitleBar()
            .toolbar {
                // Keeps this bar as tall as Members', so the window doesn't jump between them.
                ToolbarItem(placement: .primaryAction) {
                    Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) // layout-ok: an invisible item that holds the bar's height
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .foregroundStyle(FatlineStyle.ink)
        .tint(FatlineStyle.action)
        .task {
            if membership.isAdmin && approved { waiting = try? await model.waitingRequests() }
        }
        .alert(approved ? "Leave \(membership.title)?" : "Remove this network from this Mac?", isPresented: $confirmingLeave) {
            Button("Cancel", role: .cancel) {}
                .keyboardShortcut(.defaultAction)
            Button(approved ? "Leave" : "Remove", role: .destructive) {
                state.leaveNetwork()
                dismissWindow(id: "settings")
            }
        } message: {
            Text(approved ? "Your posts, replies, and likes there are deleted. You can ask to join again." : "You can add it again later.")
        }
    }

    private static func requests(_ count: Int) -> String? {
        count == 0 ? nil : count == 1 ? "1 request" : "\(count) requests"
    }
}

/// The network's members, as People lists who you follow: you first, then each with Mute or Unmute.
struct NetworkMembersView: View {
    @Environment(AppState.self) private var state
    @State private var error: String?
    @State private var changing: Set<UInt64> = []

    private var model: NetworkModel { state.networks }

    private var members: [NetworkMember] {
        let own = model.ownFID
        return model.members.filter { $0.fid == own } + model.members.filter { $0.fid != own }
    }

    var body: some View {
        let members = members
        VStack(spacing: 0) {
            FatlineDivider()
            if let error {
                FeedMessage(text: error, color: FatlineStyle.danger)
                CastDivider()
            }
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(members) { member in
                        row(member)
                        if member.id != members.last?.id { CastDivider() }
                    }
                }
            }
        }
        .background(FatlineStyle.paper)
        .navigationTitle("Members")
        .settingsTitleBar()
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) // layout-ok: an invisible item that holds the bar's height
            }
            .sharedBackgroundVisibility(.hidden)
        }
    }

    private func row(_ member: NetworkMember) -> some View {
        let isYou = member.fid == model.ownFID
        let action = member.muted ? "Unmute" : "Mute"
        return HStack(alignment: .firstTextBaseline, spacing: FatlineStyle.itemGap) {
            Text(verbatim: member.handle)
                .font(FatlineStyle.bodyStrong)
                .foregroundStyle(member.muted ? FatlineStyle.secondary : FatlineStyle.ink)
            if let detail = detail(member, isYou: isYou) {
                Text(verbatim: detail)
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: FatlineStyle.itemGap)
            if !isYou {
                Button { toggle(member) } label: {
                    Text(action)
                        .font(FatlineStyle.body)
                        .foregroundStyle(member.muted ? FatlineStyle.ink : FatlineStyle.secondary)
                        .frame(minWidth: 56, minHeight: FatlineStyle.compactButtonHeight, alignment: .trailing) // layout-ok: People's button width
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(changing.contains(member.fid))
                .accessibilityLabel("\(action) \(member.handle)")
            }
        }
        .frame(minHeight: FatlineStyle.compactButtonHeight)
        .padding(.horizontal, FatlineStyle.gutter)
        .padding(.vertical, 3) // layout-ok: makes people rows 36, as in People
    }

    /// You, or their name, then Admin and Muted where they apply.
    private func detail(_ member: NetworkMember, isYou: Bool) -> String? {
        var parts: [String] = []
        if isYou { parts.append("You") } else if !member.displayName.isEmpty { parts.append(member.displayName) }
        if member.role == "admin" { parts.append("Admin") }
        if member.muted { parts.append("Muted") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func toggle(_ member: NetworkMember) {
        changing.insert(member.fid)
        error = nil
        Task {
            do { try await model.setMuted(member.fid, !member.muted) } catch { self.error = error.localizedDescription }
            changing.remove(member.fid)
        }
    }
}

/// Your picture, name, and bio in this network, as the canvas's "Your profile" shows them. A new
/// picture applies at once. Save keeps the name and bio.
struct NetworkProfileView: View {
    let membership: NetworkMembership

    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var bio = ""
    @State private var saving = false
    @State private var changingPicture = false
    @State private var choosing = false
    @State private var error: String?
    @State private var avatar: CGImage?

    private static let maxName = 32
    private static let maxBio = 160
    private static let avatarSize: CGFloat = 56 // layout-ok: the profile picture on the canvas

    private var model: NetworkModel { state.networks }
    private var valid: Bool { name.count <= Self.maxName && bio.count <= Self.maxBio }
    private var ownAvatar: Bool { model.you?.ownAvatar ?? false }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Profile").fatlineScreenTitle()
                HStack(spacing: FatlineStyle.groupGap) {
                    picture
                    VStack(alignment: .leading, spacing: FatlineStyle.castGap) {
                        Button(changingPicture ? "Changing…" : "Change Picture") { choosing = true }
                            .buttonStyle(FatlineOutlineButton())
                            .disabled(changingPicture)
                        if ownAvatar {
                            Button("Use Farcaster Picture") { change(to: nil) }
                                .buttonStyle(.plain)
                                .font(FatlineStyle.meta)
                                .foregroundStyle(FatlineStyle.ink)
                                .disabled(changingPicture)
                        } else {
                            Text("Using your Farcaster picture")
                                .font(FatlineStyle.meta)
                                .foregroundStyle(FatlineStyle.secondary)
                        }
                    }
                }
                .padding(.top, FatlineStyle.gutter)
                label("Name").padding(.top, FatlineStyle.gutter)
                field("Name", text: $name, limit: Self.maxName).padding(.top, FatlineStyle.castGap)
                label("Bio").padding(.top, FatlineStyle.groupGap)
                field("Bio", text: $bio, limit: Self.maxBio, lines: 3).padding(.top, FatlineStyle.castGap)
                HStack(alignment: .firstTextBaseline, spacing: FatlineStyle.itemGap) {
                    Text(verbatim: model.you?.username ?? membership.title).font(FatlineStyle.bodyStrong)
                    Spacer(minLength: FatlineStyle.itemGap)
                    Text("From Farcaster")
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.secondary)
                }
                .padding(.top, FatlineStyle.gutter)
                if let error {
                    Text(error)
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, FatlineStyle.itemGap)
                }
            }
            .padding(.horizontal, FatlineStyle.gutter)
            .padding(.top, FatlineStyle.itemGap)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fatlineBottomAction(gutter: FatlineStyle.gutter, bottom: FatlineStyle.gutter) {
            Button(action: save) {
                Text(saving ? "Saving…" : "Save").frame(maxWidth: .infinity)
            }
            .buttonStyle(FatlinePrimaryButton(isWorking: saving))
            .keyboardShortcut(.defaultAction)
            .disabled(saving || !valid)
        }
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        // The title is in the content, as on Connection.
        .fatlineStepBar()
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.image]) { result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let image = NetworkImage(contentsOf: url) { change(to: image) } else { error = "That isn’t a picture Fatline can read." }
        }
        .onAppear {
            name = model.you?.displayName ?? ""
            bio = model.you?.bio ?? ""
        }
        .task(id: model.you?.avatar) { await loadAvatar() }
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
        .frame(width: Self.avatarSize, height: Self.avatarSize)
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
            .textFieldStyle(.plain)
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
        saving = true
        error = nil
        Task {
            do {
                try await model.updateProfile(displayName: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                              bio: bio.trimmingCharacters(in: .whitespacesAndNewlines))
                model.toast = "Saved"
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }
}

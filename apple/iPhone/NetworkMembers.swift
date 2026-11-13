import SwiftUI

/// A network's members, pushed in Settings: you first, then each member with Mute or Unmute, as
/// People lists who you follow.
struct NetworkMembersView: View {
    @Environment(NetworkModel.self) private var model
    @State private var error: String?
    @State private var changing: Set<UInt64> = []

    private var members: [NetworkMember] {
        let own = model.ownFID
        return model.members.filter { $0.fid == own } + model.members.filter { $0.fid != own }
    }

    var body: some View {
        let members = members
        VStack(spacing: 0) {
            FatlineDivider()
            ScrollView {
                LazyVStack(spacing: 0) {
                    if let error {
                        FeedMessage(text: error, color: FatlineStyle.danger)
                        CastDivider()
                    }
                    ForEach(members) { member in
                        row(member)
                        CastDivider()
                    }
                    Text("Muting hides someone’s posts and replies on all your devices.")
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, FatlineStyle.gutter)
                        .padding(.vertical, FatlineStyle.rowPadding)
                }
            }
            .refreshable { await model.refresh() }
        }
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .fatlineTitle("Members")
    }

    private func row(_ member: NetworkMember) -> some View {
        let isYou = member.fid == model.ownFID
        let action = member.muted ? "Unmute" : "Mute"
        return HStack(alignment: .firstTextBaseline, spacing: FatlineStyle.itemGap) {
            Text(verbatim: member.handle)
                .font(FatlineStyle.bodyStrong)
                .foregroundStyle(member.muted ? FatlineStyle.secondary : FatlineStyle.ink)
                .lineLimit(1)
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
                        .frame(minWidth: FatlineStyle.postPillWidth, minHeight: FatlineStyle.buttonHitHeight, alignment: .trailing)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .disabled(changing.contains(member.fid))
                .accessibilityLabel("\(action) \(member.handle)")
            }
        }
        .padding(.horizontal, FatlineStyle.gutter)
        .frame(minHeight: FatlineStyle.listRowHeight)
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
        Platform.haptic(.pick)
        changing.insert(member.fid)
        error = nil
        Task {
            do { try await model.setMuted(member.fid, !member.muted) } catch { self.error = error.localizedDescription }
            changing.remove(member.fid)
        }
    }
}

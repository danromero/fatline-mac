import SwiftUI

/// Settings for the network that's showing, from the three dots in its bar: you there with its
/// address, Profile, Members, Manage Network for admins, the version, and Leave at the bottom, apart so
/// it's hard to reach by accident. A network that hasn't let you in has only Remove from This iPhone.
/// It follows the Farcaster Settings row for row.
struct NetworkSettingsSheet: View {
    let membership: NetworkMembership

    @Environment(NetworkModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var waiting: Int?
    @State private var opening = false
    @State private var problem: String?
    @State private var confirmingLeave = false
    @State private var leaving = false

    private var approved: Bool { membership.status == .approved }
    /// The network's mark beside its address.
    private static let markSize: CGFloat = 20 // layout-ok: the mark beside 13-point text, as on the canvas

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                FatlineDivider()
                ScrollView {
                    VStack(spacing: 0) {
                        account
                        CastDivider()
                        if approved {
                            NavigationLink { NetworkProfileView() } label: { row("Profile") }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("network-settings-profile")
                            CastDivider()
                            NavigationLink { NetworkMembersView() } label: {
                                row("Members", value: model.members.isEmpty ? nil : "\(model.members.count)")
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("network-settings-members")
                            CastDivider()
                            if membership.isAdmin {
                                Button(action: manage) {
                                    row("Manage Network", value: waiting.flatMap(Self.requests), symbol: "arrow.up.right")
                                }
                                .buttonStyle(.plain)
                                .disabled(opening)
                                .accessibilityHint("Opens the admin pages in Safari")
                                CastDivider()
                            }
                        }
                        #if DEBUG
                        Button {
                            model.forgetEverything()
                            dismiss()
                        } label: {
                            Text("Forget Networks on This iPhone")
                                .font(FatlineStyle.body)
                                .frame(maxWidth: .infinity, minHeight: FatlineStyle.listRowHeight, alignment: .leading)
                                .padding(.horizontal, FatlineStyle.gutter)
                                .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        CastDivider()
                        #endif
                        Text(verbatim: FeedModel.versionLine)
                            .font(FatlineStyle.meta)
                            .foregroundStyle(FatlineStyle.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, FatlineStyle.gutter)
                            .padding(.top, FatlineStyle.gutter + FatlineStyle.itemGap)
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { bottom }
            }
            .foregroundStyle(FatlineStyle.ink)
            .background(FatlineStyle.paper.ignoresSafeArea())
            .fatlineTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: {
                        Text("Done").font(FatlineStyle.body)
                    }
                }
            }
        }
        // Mute and Saved happen in here, so their toasts show here too.
        .overlay(alignment: .bottom) {
            NetworkToastHost().padding(.bottom, FatlineStyle.plusClearance)
        }
        .tint(FatlineStyle.action)
        .task {
            if membership.isAdmin && approved { waiting = try? await model.waitingRequests() }
        }
        .alert("Something went wrong", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(problem ?? "")
        }
    }

    /// You there, with the network's mark and address, so a network can't pass for another. The address
    /// always shows whole: at the largest text sizes it moves under your name rather than truncating.
    private var account: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: FatlineStyle.groupGap) {
                handle
                Spacer(minLength: FatlineStyle.itemGap)
                address
            }
            VStack(alignment: .leading, spacing: FatlineStyle.castGap) {
                handle
                address
            }
            .padding(.vertical, FatlineStyle.groupGap)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, FatlineStyle.gutter)
        .frame(minHeight: FatlineStyle.listRowHeight)
        .accessibilityElement(children: .combine)
    }

    private var handle: some View {
        Text(verbatim: model.you?.handle ?? model.handle(for: membership.fid))
            .font(FatlineStyle.bodyStrong)
            .lineLimit(1)
    }

    private var address: some View {
        HStack(spacing: FatlineStyle.itemGap) {
            NetworkMark(name: membership.title, icon: membership.icon, size: Self.markSize)
            Text(verbatim: membership.host)
                .font(FatlineStyle.meta)
                .foregroundStyle(FatlineStyle.secondary)
                .fixedSize()
        }
    }

    /// Leave, or Remove from This iPhone for a network that never let you in.
    private var bottom: some View {
        VStack(alignment: .leading, spacing: 0) {
            CastDivider()
            Button {
                if approved {
                    confirmingLeave = true
                } else {
                    model.forget(membership.host)
                    dismiss()
                }
            } label: {
                Text(approved ? (leaving ? "Leaving…" : "Leave \(membership.title)") : "Remove from This iPhone")
                    .font(FatlineStyle.body)
                    .foregroundStyle(FatlineStyle.danger)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, minHeight: FatlineStyle.buttonHitHeight, alignment: .leading)
                    .padding(.horizontal, FatlineStyle.gutter)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .disabled(leaving)
            .accessibilityIdentifier("network-leave")
        }
        .padding(.bottom, FatlineStyle.itemGap)
        .background(FatlineStyle.paper)
        .confirmationDialog("Leave \(membership.title)?", isPresented: $confirmingLeave, titleVisibility: .visible) {
            Button("Leave", role: .destructive, action: leave)
        } message: {
            Text("Your posts, replies, and likes there are deleted. You can ask to join again.")
        }
    }

    /// Ends every session there and removes the network, so Farcaster shows, and this sheet goes with it.
    private func leave() {
        leaving = true
        Task {
            do {
                try await model.leave()
                Platform.haptic(.done)
                dismiss()
            } catch {
                Platform.haptic(.problem)
                problem = error.localizedDescription
            }
            leaving = false
        }
    }

    private func row(_ title: String, value: String? = nil, symbol: String = "chevron.right") -> some View {
        HStack(spacing: FatlineStyle.groupGap) {
            Text(title).font(FatlineStyle.body)
            Spacer(minLength: FatlineStyle.itemGap)
            if let value {
                Text(value)
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.secondary)
            }
            Image(systemName: symbol)
                .font(FatlineStyle.metaStrong)
                .foregroundStyle(FatlineStyle.secondary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, FatlineStyle.gutter)
        .frame(minHeight: FatlineStyle.listRowHeight)
        .contentShape(.rect)
    }

    /// The one-time link to the admin pages, opened in Safari.
    private func manage() {
        opening = true
        Task {
            do { openURL(try await model.adminLink()) } catch { problem = error.localizedDescription }
            opening = false
        }
    }

    private static func requests(_ count: Int) -> String? {
        count == 0 ? nil : count == 1 ? "1 request" : "\(count) requests"
    }
}

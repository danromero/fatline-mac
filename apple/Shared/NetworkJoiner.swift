import Foundation

// Joining a network, the way setup works: its address or invite code, the recovery phrase if this
// device has no key yet, then a step that shows which network it is before anything about this account
// or device is sent, then where things stand. Each app draws the steps; this is their logic.

/// What the join steps share: the address, what's happening, and what went wrong.
@MainActor
@Observable
final class NetworkJoiner {
    enum Step: Hashable {
        case confirm(Preview)
        case phrase
        case result(NetworkModel.JoinResult)
    }

    /// Which network the address names, as the confirm step shows it, before anything about the device is sent. With an invite
    /// code the network knows, its name and picture; with only an address, nothing it says about itself.
    struct Preview: Hashable, Sendable {
        let host: String
        let hasInvite: Bool
        var name: String?
        var icon: String?

        /// The name to show, checked as for a network joined, so it can't pass for another.
        static func make(host: String, invite: NetworkInvite?, others: [NetworkMembership]) -> Preview {
            guard let invite else { return Preview(host: host, hasInvite: false) }
            return Preview(host: host, hasInvite: true,
                           name: NetworkMembership.acceptedName(invite.name, host: host, others: others),
                           icon: invite.icon)
        }
    }

    var address = ""
    private(set) var joining = false
    /// Reading the invite code's network, before the confirm step.
    private(set) var checking = false
    var error: String?
    private(set) var importing = false
    private(set) var phraseError: String?

    /// Set once the view that runs the steps appears.
    var model: NetworkModel?
    /// This account's Farcaster picture, when the app has read it, for the network to copy.
    var avatar: String?
    /// Moves the flow on, and back to the address after a failure there.
    var push: (Step) -> Void = { _ in }
    var backToAddress: () -> Void = {}

    var canContinue: Bool { !joining && !checking && !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// From the address on: the recovery phrase first if this device has no key yet, then the confirm
    /// step. With a code, the network is asked what its invite page shows; nothing about this account
    /// or device reaches the network until Join.
    func next() {
        guard canContinue, let model else { return }
        guard NetworkModel.parse(address).host != nil else {
            error = "Use the format server.example or CODE@server.example."
            return
        }
        if model.needsPhrase {
            phraseError = nil
            push(.phrase)
            return
        }
        checking = true
        Task {
            defer { checking = false }
            if let preview = await preview() { push(.confirm(preview)) }
        }
    }

    /// Join or Ask to Join, from the confirm step.
    func confirm() {
        guard !joining, let model else { return }
        error = nil
        // The key was forgotten since the address step: ask for the phrase, which leads back here.
        if model.needsPhrase {
            phraseError = nil
            push(.phrase)
            return
        }
        joining = true
        Task {
            defer { joining = false }
            do {
                push(.result(try await model.join(typed: address, avatar: avatar)))
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Approves this device with the phrase, which only Optimism hears about, then shows the confirm step.
    func importPhrase(_ phrase: String) {
        guard let model else { return }
        importing = true
        phraseError = nil
        Task {
            defer { importing = false }
            do {
                try await model.approveDevice(phrase: phrase)
            } catch {
                phraseError = error.localizedDescription
                return
            }
            if let preview = await preview() {
                push(.confirm(preview))
            } else {
                // The key is approved, so going back to the address lets them fix it and try again.
                backToAddress()
            }
        }
    }

    /// What the confirm step shows for the address, or nil with `error` set.
    private func preview() async -> Preview? {
        guard let model else { return nil }
        let (host, code) = NetworkModel.parse(address)
        guard let host else { return nil }
        guard let code else { return .make(host: host, invite: nil, others: model.memberships) }
        do {
            guard let invite = try await NetworkClient.invite(host: host, code: code) else {
                error = "\(host) doesn’t know that invite code."
                return nil
            }
            return .make(host: host, invite: invite, others: model.memberships)
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }
}

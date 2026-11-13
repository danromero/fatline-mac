import SwiftUI

// Joining a network, the way setup works: its address or invite code, then the recovery phrase if
// this Mac has no key yet, then where things stand. Add Network runs these steps on their own, and
// getting started runs them after choosing a private network. `NetworkJoiner` holds their logic.

/// Add Network from the title menu or ⇧⌘N: the join steps in the window, as setup does.
struct AddNetworkFlow: View {
    @Environment(AppState.self) private var state
    @State private var path: [NetworkJoiner.Step] = []
    @State private var joiner = NetworkJoiner()

    var body: some View {
        NavigationStack(path: $path) {
            NetworkAddressStep(joiner: joiner, back: { state.addingNetwork = false })
                .navigationDestination(for: NetworkJoiner.Step.self) { step in
                    NetworkJoinStep(step: step, joiner: joiner, footnote: "Only needed once on this Mac.") { result in
                        finish(result)
                    }
                }
        }
        .tint(FatlineStyle.action)
        .onAppear {
            joiner.model = state.networks
            joiner.avatar = state.model?.ownAvatarLink
            joiner.push = { path.append($0) }
            joiner.backToAddress = { path.removeAll() }
        }
    }

    private func finish(_ result: NetworkModel.JoinResult) {
        switch result.status {
        case .approved, .pending: state.networks.select(result.host)
        case .refused: state.networks.forget(result.host)
        }
        state.addingNetwork = false
    }
}

/// The step after the address: the recovery phrase, or where joining left things.
struct NetworkJoinStep: View {
    let step: NetworkJoiner.Step
    let joiner: NetworkJoiner
    var footnote: String?
    let finish: (NetworkModel.JoinResult) -> Void

    var body: some View {
        switch step {
        case .confirm(let preview):
            NetworkConfirmStep(preview: preview, joiner: joiner)
        case .phrase:
            RecoveryPhraseStep(
                title: "Import your account",
                instruction: "Enter your Farcaster recovery phrase, not another wallet’s.",
                footnote: footnote,
                busy: joiner.importing,
                error: joiner.phraseError,
                submit: joiner.importPhrase
            ) { _ in EmptyView() }
        case .result(let result):
            NetworkJoinResultStep(result: result) { finish(result) }
        }
    }
}

/// Setup on the Mac: the splash, then Farcaster or a private network. Farcaster goes on to how this
/// Mac reaches it, a private network to its address, and both end at the recovery phrase.
struct GettingStarted: View {
    private enum Step: Hashable {
        case choose
        case connection(ConnectionKind)
        case signIn
        case address
        case join(NetworkJoiner.Step)
    }

    @Environment(AppState.self) private var state
    /// With a network already added, this is Farcaster's setup, so it starts at connecting.
    @State private var farcasterOnly: Bool
    @State private var path: [Step] = []
    @State private var choice = SetupChoice.farcaster
    @State private var joiner = NetworkJoiner()

    init(farcasterOnly: Bool) {
        _farcasterOnly = State(initialValue: farcasterOnly)
    }

    private var session: PostingSession { state.session }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if farcasterOnly {
                    connection(.neynar)
                } else {
                    WelcomeSplash(session: session) { path = [.choose] }
                }
            }
            .navigationDestination(for: Step.self) { step in
                switch step {
                case .choose:
                    NetworkSetupChoiceStep(choice: $choice) {
                        switch choice {
                        case .farcaster: path.append(Connection.isSetByLaunch ? .signIn : .connection(.neynar))
                        case .network: path.append(.address)
                        }
                    }
                case .connection(let kind):
                    connection(kind)
                case .signIn:
                    SignInView()
                case .address:
                    NetworkAddressStep(joiner: joiner)
                case .join(let step):
                    NetworkJoinStep(step: step, joiner: joiner) { result in finish(result) }
                }
            }
        }
        .tint(FatlineStyle.action)
        .onAppear {
            joiner.model = state.networks
            joiner.push = { path.append(.join($0)) }
            joiner.backToAddress = { path = [.choose, .address] }
            state.settingUp = !farcasterOnly
        }
        .onDisappear { state.settingUp = false }
    }

    private func connection(_ kind: ConnectionKind) -> some View {
        ConnectionForm(setup: kind, saved: session.savedConnection) { other in
            path.append(.connection(other))
        } finish: { choice in
            try session.useConnection(choice)
            path.append(.signIn)
        }
    }

    private func finish(_ result: NetworkModel.JoinResult) {
        switch result.status {
        case .approved, .pending:
            state.networks.select(result.host)
        case .refused:
            state.networks.forget(result.host)
            path = [.choose]
        }
    }
}

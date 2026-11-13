import SwiftUI

// Joining a network on iPhone, with the steps both apps share: getting started's choice, and Add
// Network from the Networks sheet. `NetworkJoiner` holds their logic.

/// Setup on iPhone: the splash, then Farcaster or a private network. Farcaster goes on to how this
/// iPhone reaches it and the recovery phrase; a private network to its address, the confirm step, the
/// phrase if this iPhone has no key yet, and where joining left things.
struct GettingStarted<SignIn: View>: View {
    private enum Step: Hashable {
        case choose
        case connection(ConnectionKind)
        case signIn
        case address
        case join(NetworkJoiner.Step)
    }

    let session: PostingSession
    /// Opens the Networks sheet from the splash, once this iPhone has a network.
    let switchNetwork: (() -> Void)?
    @ViewBuilder let signIn: () -> SignIn

    @Environment(NetworkModel.self) private var networks
    @State private var path: [Step] = []
    @State private var choice = SetupChoice.farcaster
    @State private var joiner = NetworkJoiner()

    var body: some View {
        NavigationStack(path: $path) {
            WelcomeSplash(session: session) { path = [.choose] }
                .overlay(alignment: .top) {
                    // With a network on this iPhone, the way back to it while Farcaster isn't set up.
                    if let switchNetwork {
                        NetworkTitleButton(membership: nil, othersHaveNews: networks.othersHaveNews, action: switchNetwork)
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
                        ConnectionForm(setup: kind, saved: session.savedConnection) { other in
                            path.append(.connection(other))
                        } finish: { choice in
                            try session.useConnection(choice)
                            path.append(.signIn)
                        }
                    case .signIn:
                        signIn()
                    case .address:
                        NetworkAddressStep(joiner: joiner)
                    case .join(let step):
                        NetworkJoinStep(step: step, joiner: joiner, finish: finish)
                    }
                }
        }
        .tint(FatlineStyle.action)
        .onAppear {
            joiner.model = networks
            joiner.push = { path.append(.join($0)) }
            joiner.backToAddress = { path = [.choose, .address] }
        }
    }

    /// In or waiting shows the network, which takes over from setup. Not approved goes back to the choice.
    private func finish(_ result: NetworkModel.JoinResult) {
        switch result.status {
        case .approved, .pending:
            networks.select(result.host)
        case .refused:
            networks.forget(result.host)
            path = [.choose]
        }
    }
}

/// Add Network from the Networks sheet: the join steps in a full-screen cover. Back on the address
/// closes it; in or waiting shows the network, and not approved forgets it.
struct AddNetworkFlow: View {
    let close: () -> Void

    @Environment(NetworkModel.self) private var networks
    @State private var path: [NetworkJoiner.Step] = []
    @State private var joiner = NetworkJoiner()

    var body: some View {
        NavigationStack(path: $path) {
            NetworkAddressStep(joiner: joiner, back: close)
                .navigationDestination(for: NetworkJoiner.Step.self) { step in
                    NetworkJoinStep(step: step, joiner: joiner, finish: finish)
                }
        }
        .tint(FatlineStyle.action)
        .onAppear {
            joiner.model = networks
            joiner.push = { path.append($0) }
            joiner.backToAddress = { path.removeAll() }
        }
    }

    private func finish(_ result: NetworkModel.JoinResult) {
        switch result.status {
        case .approved, .pending: networks.select(result.host)
        case .refused: networks.forget(result.host)
        }
        close()
    }
}

/// The steps after the address: the confirm step, the recovery phrase, and where joining left things.
private struct NetworkJoinStep: View {
    let step: NetworkJoiner.Step
    let joiner: NetworkJoiner
    let finish: (NetworkModel.JoinResult) -> Void

    var body: some View {
        switch step {
        case .confirm(let preview):
            NetworkConfirmStep(preview: preview, joiner: joiner)
        case .phrase:
            RecoveryPhraseForm(busy: joiner.importing, error: joiner.phraseError, hasPendingRegistration: false,
                               connect: joiner.importPhrase, retry: {})
        case .result(let result):
            NetworkJoinResultStep(result: result) { finish(result) }
        }
    }
}

import SwiftUI

// The join steps both apps draw: the address or invite code, where joining left things, and getting
// started's choice between Farcaster and a private network. `NetworkJoiner` holds their logic, and each
// app adds its own recovery phrase step.

/// Getting started's choice.
enum SetupChoice { case farcaster, network }

/// The network's address or invite code. As the first step of Add Network, its Back leaves the flow.
struct NetworkAddressStep: View {
    @Bindable var joiner: NetworkJoiner
    /// Set when this is the flow's first step, so the bar needs a Back of its own.
    var back: (() -> Void)?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                FatlineStepHeader(title: "Add a network", instruction: "Enter the address or invite code you were given.")
                VStack(alignment: .leading, spacing: FatlineStyle.itemGap) {
                    TextField("Address or invite code", text: $joiner.address,
                              prompt: Text(verbatim: "server.example").foregroundStyle(FatlineStyle.secondary))
                        .focused($fieldFocused)
                        .autocorrectionDisabled()
                        .addressKeyboard()
                        .textFieldStyle(.plain)
                        .font(FatlineStyle.body)
                        // The default button doesn't get Return while a text field has focus.
                        .onSubmit(joiner.next)
                        .padding(FatlineStyle.fieldInset)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(FatlineStyle.quiet, in: .rect(cornerRadius: FatlineStyle.fieldRadius, style: .continuous))
                        .accessibilityLabel("Address or invite code")
                    if let error = joiner.error {
                        Text(error)
                            .font(FatlineStyle.meta)
                            .foregroundStyle(FatlineStyle.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.top, 20) // layout-ok: the setup steps' title-to-field gap
            }
            .padding(.horizontal, FatlineStyle.screenGutter)
            .padding(.top, FatlineStyle.screenTop)
            .frame(maxWidth: FatlineStyle.columnMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .fatlineBottomAction {
            Button(action: joiner.next) {
                Text(joiner.checking ? "Checking…" : "Continue").frame(maxWidth: .infinity)
            }
            .buttonStyle(FatlinePrimaryButton(isWorking: joiner.checking))
            .keyboardShortcut(.defaultAction)
            .disabled(!joiner.canContinue)
        }
        .disabled(joiner.checking)
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .fatlineStepBar()
        .toolbar {
            if let back {
                ToolbarItem(placement: .navigation) {
                    Button(action: back) { Image(systemName: "chevron.left") }
                        .help("Back")
                        .accessibilityLabel("Back")
                        .keyboardShortcut(.cancelAction)
                        .disabled(joiner.checking)
                }
            }
        }
        .navigationBarBackButtonHidden(joiner.checking)
        // There's a keyboard on hand, so the field is ready to paste into. The step replaces or
        // slides over the window's content, so focus waits for that to settle.
        .task {
            try? await Task.sleep(for: .milliseconds(150))
            fieldFocused = true
        }
        .onChange(of: joiner.address) { joiner.error = nil }
    }
}

/// Which network this is, before anything about this device is sent. With an invite
/// code, the network's mark and name, with its address under them; with only an address, the address
/// alone, since nothing a network says about itself shows before it lets you in.
struct NetworkConfirmStep: View {
    let preview: NetworkJoiner.Preview
    let joiner: NetworkJoiner

    /// The empty tile where a network's mark goes, as in Request sent.
    private static let tileSize: CGFloat = 64 // layout-ok: as on the join result
    private static let markSize: CGFloat = 76 // layout-ok: the join result's mark

    private var shownName: String { preview.name ?? preview.host }

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            Group {
                if preview.hasInvite { invited } else { askOnly }
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: 300) // layout-ok: a readable measure for centered text
            Spacer(minLength: 0)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, FatlineStyle.screenGutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .fatlineBottomAction {
            VStack(spacing: FatlineStyle.itemGap) {
                if let error = joiner.error {
                    Text(error)
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(preview.hasInvite ? "\(shownName) will see your Farcaster username and picture."
                                       : "The admin will see your Farcaster username and picture.")
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button(action: joiner.confirm) {
                    Text(joiner.joining ? "Joining…" : preview.hasInvite ? "Join \(shownName)" : "Ask to Join")
                        .lineLimit(1)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(FatlinePrimaryButton(isWorking: joiner.joining))
                .keyboardShortcut(.defaultAction)
                .disabled(joiner.joining)
                .accessibilityIdentifier("network-join")
            }
            .multilineTextAlignment(.center)
        }
        .fatlineStepBar()
        .navigationBarBackButtonHidden(joiner.joining)
        .onAppear { joiner.error = nil }
    }

    private var invited: some View {
        VStack(spacing: 0) {
            NetworkMark(name: shownName, icon: preview.icon, size: Self.markSize)
            Text(verbatim: shownName)
                .font(FatlineStyle.display)
                .tracking(-0.8)
                .padding(.top, FatlineStyle.groupGap)
                .accessibilityAddTraits(.isHeader)
            // The address under the network's own name, so a network can't pass for another.
            if preview.name != nil {
                Text(verbatim: preview.host)
                    .font(FatlineStyle.body)
                    .foregroundStyle(FatlineStyle.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                    .padding(.top, FatlineStyle.itemGap)
            }
        }
    }

    private var askOnly: some View {
        VStack(spacing: 0) {
            NetworkEmptyTile(size: Self.tileSize)
            Text(verbatim: preview.host)
                .fatlineScreenTitle()
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .padding(.top, FatlineStyle.gutter)
        }
    }
}

/// The dashed tile where a network's mark goes, before the network has said anything about itself.
struct NetworkEmptyTile: View {
    var size: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: size * FatlineStyle.markRadiusRatio, style: .continuous)
            .strokeBorder(FatlineStyle.outline, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Where joining left things: in (the network's logo, name, and size), waiting for the admin, or not
/// approved.
struct NetworkJoinResultStep: View {
    let result: NetworkModel.JoinResult
    let done: () -> Void

    var body: some View {
        Group {
            if result.status == .approved {
                approved
            } else {
                NetworkStatusView(status: result.status, host: result.host, button: result.status == .pending ? "Done" : "OK", action: done)
            }
        }
        .fatlineStepBar()
        .navigationBarBackButtonHidden(true)
    }

    private var approved: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: 0) {
                NetworkMark(name: result.name ?? result.host, icon: result.icon, size: 76) // layout-ok: the join result's mark
                Text(verbatim: result.name ?? result.host)
                    .font(FatlineStyle.display)
                    .tracking(-0.8)
                    .padding(.top, FatlineStyle.groupGap)
                    .accessibilityLabel("You’re in \(result.name ?? result.host)")
                    .accessibilityAddTraits(.isHeader)
                // The logo, the name, and the size. The confirm step just before showed the address.
                if let count = result.memberCount {
                    Text(count == 1 ? "1 member" : "\(count) members")
                        .font(FatlineStyle.body)
                        .foregroundStyle(FatlineStyle.secondary)
                        .padding(.top, FatlineStyle.itemGap)
                }
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: 300) // layout-ok: a readable measure for centered text
            Spacer(minLength: 0)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, FatlineStyle.screenGutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .fatlineBottomAction {
            Button(action: done) {
                Text("Open \(result.name ?? result.host)").frame(maxWidth: .infinity)
            }
            .buttonStyle(FatlinePrimaryButton())
            .keyboardShortcut(.defaultAction)
        }
    }
}

/// Farcaster or a private network, as two cards with radio marks, then Continue.
struct NetworkSetupChoiceStep: View {
    @Binding var choice: SetupChoice
    let next: () -> Void

    private static let iconSize = FatlineStyle.avatarSize
    #if os(macOS)
    private static let radioSize: CGFloat = 18 // layout-ok: a radio mark beside 14-point text
    private static let radioCenter: CGFloat = 6 // layout-ok: the radio's center
    #else
    private static let radioSize: CGFloat = 20 // layout-ok: a radio mark beside 16-point text, as on the canvas
    private static let radioCenter: CGFloat = 8 // layout-ok: the radio's center, as on the canvas
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                FatlineStepHeader(title: "Get started", instruction: "You can add the other one later.")
                VStack(spacing: FatlineStyle.itemGap) {
                    card(.farcaster, title: "Farcaster", detail: "The people you follow") {
                        Image("Portal")
                            .resizable()
                            .frame(width: Self.iconSize, height: Self.iconSize)
                            .clipShape(.circle)
                            .accessibilityHidden(true)
                    }
                    card(.network, title: "Private network", detail: "One you were invited to") {
                        RoundedRectangle(cornerRadius: Self.iconSize * FatlineStyle.markRadiusRatio, style: .continuous)
                            .strokeBorder(FatlineStyle.outline, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                            .frame(width: Self.iconSize, height: Self.iconSize)
                    }
                }
                .padding(.top, 20) // layout-ok: the setup steps' title-to-field gap
            }
            .padding(.horizontal, FatlineStyle.screenGutter)
            .padding(.top, FatlineStyle.screenTop)
            .frame(maxWidth: FatlineStyle.columnMaxWidth, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .fatlineBottomAction {
            Button(action: next) {
                Text("Continue").frame(maxWidth: .infinity)
            }
            .buttonStyle(FatlinePrimaryButton())
            .keyboardShortcut(.defaultAction)
            .accessibilityIdentifier("setup-continue")
        }
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .fatlineStepBar()
    }

    private func card<Icon: View>(_ option: SetupChoice, title: String, detail: String, @ViewBuilder icon: () -> Icon) -> some View {
        let on = choice == option
        return Button { choice = option } label: {
            HStack(spacing: FatlineStyle.groupGap) {
                icon()
                VStack(alignment: .leading, spacing: 0) {
                    Text(title).font(FatlineStyle.bodyStrong)
                    Text(detail)
                        .font(FatlineStyle.meta)
                        .foregroundStyle(FatlineStyle.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Circle()
                    .strokeBorder(on ? .clear : FatlineStyle.outline, lineWidth: 1.5)
                    .background(on ? FatlineStyle.action : .clear, in: .circle)
                    .overlay {
                        if on {
                            Circle().fill(FatlineStyle.actionInk).frame(width: Self.radioCenter, height: Self.radioCenter)
                        }
                    }
                    .frame(width: Self.radioSize, height: Self.radioSize)
            }
            .padding(FatlineStyle.fieldInset)
            .background(FatlineStyle.quiet, in: .rect(cornerRadius: FatlineStyle.fieldRadius, style: .continuous))
            .overlay {
                if on {
                    RoundedRectangle(cornerRadius: FatlineStyle.fieldRadius, style: .continuous)
                        .strokeBorder(FatlineStyle.ink, lineWidth: 1.5)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }
}

private extension View {
    /// iPhone's keyboard for an address: no capitals, the URL layout, and Continue on its return key.
    func addressKeyboard() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never)
            .keyboardType(.URL)
            .submitLabel(.continue)
        #else
        self
        #endif
    }
}

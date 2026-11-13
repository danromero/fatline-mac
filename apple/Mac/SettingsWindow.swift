import SwiftUI

/// The Settings window: the account, the people it follows, and how it connects. While a network
/// shows, it's that network's settings instead.
struct SettingsWindow: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        Group {
            if let network = state.networks.selected {
                NetworkSettingsStack(membership: network)
                    .id(network.host)
            } else if let model = state.model {
                SettingsStack(model: model, username: state.username)
            } else {
                FatlineStyle.paper.settingsTitleBar()
            }
        }
        .frame(width: 360, height: 560 - FatlineStyle.headerHeight) // layout-ok: the Settings window's size
        .publishesMenuFlags(state)
        // After signing out there's nothing left to show here.
        .onChange(of: state.model == nil && state.networks.selected == nil) { _, empty in
            if empty { dismissWindow(id: "settings") }
        }
    }
}

private struct SettingsStack: View {
    let model: FeedModel
    let username: String?

    @Environment(AppState.self) private var state
    @State private var confirmingSignOut = false
    @State private var signOutError: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                FatlineDivider()
                ScrollView {
                    VStack(spacing: 0) {
                        if let username {
                            SettingsAccountRow(handle: username) {
                                Text("Signed in")
                                    .font(FatlineStyle.meta)
                                    .foregroundStyle(FatlineStyle.secondary)
                            }
                            CastDivider()
                        }
                        NavigationLink { PeopleView(model: model) } label: { SettingsRow(title: "People") }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("settings-people")
                        CastDivider()
                        if !Connection.isSetByLaunch {
                            NavigationLink { ConnectionSettings() } label: {
                                SettingsRow(title: "Connection", value: state.session.connection.name)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("settings-connection")
                            CastDivider()
                        }
                        AppSwitches()
                        SettingsVersion()
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if state.session.account?.fid != nil { signOutSection }
                }
            }
            .background(FatlineStyle.paper)
            .navigationTitle("Settings")
            .settingsTitleBar()
            .toolbar {
                // A toolbar item keeps this bar as tall as People's, so the window doesn't jump between them.
                ToolbarItem(placement: .primaryAction) {
                    Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) // layout-ok: an invisible item that holds the bar's height
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .foregroundStyle(FatlineStyle.ink)
        .tint(FatlineStyle.action)
        .alert("Couldn’t sign out", isPresented: Binding(get: { signOutError != nil }, set: { if !$0 { signOutError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(signOutError ?? "")
        }
    }

    private var signOutSection: some View {
        let block = state.session.signOutBlock
        return VStack(alignment: .leading, spacing: 0) {
            CastDivider()
            SettingsDangerButton(title: "Sign Out", enabled: block == nil) { confirmingSignOut = true }
                .accessibilityIdentifier("sign-out")
            .alert("Sign out of Fatline?", isPresented: $confirmingSignOut) {
                // Claiming Return for Cancel, so the system can't give it to Sign Out.
                Button("Cancel", role: .cancel) {}
                    .keyboardShortcut(.defaultAction)
                Button("Sign Out", role: .destructive, action: signOut)
            } message: {
                Text("This removes the posting key from this Mac and keeps this account’s draft.")
            }
            if let block {
                Text(block)
                    .font(FatlineStyle.meta)
                    .foregroundStyle(FatlineStyle.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, FatlineStyle.gutter)
            }
        }
        .padding(.bottom, FatlineStyle.itemGap)
        .background(FatlineStyle.paper)
    }

    private func signOut() {
        do {
            try state.session.signOut()
        } catch {
            signOutError = error.localizedDescription
        }
    }
}

/// Changing how the app reaches Farcaster, from Settings. Saving goes back to Settings.
private struct ConnectionSettings: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ConnectionForm(settings: state.session.savedConnection) { choice in
            try state.session.useConnection(choice)
            dismiss()
        }
    }
}

/// The account at the top of Settings: the name in bold, and something about it on the trailing edge.
struct SettingsAccountRow<Trailing: View>: View {
    let handle: String
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: FatlineStyle.groupGap) {
            Text(verbatim: handle)
                .font(FatlineStyle.bodyStrong)
            Spacer(minLength: FatlineStyle.itemGap)
            trailing()
        }
        .settingsRowFrame()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings-account")
    }
}

/// A row that opens something: a title, maybe a value, and a chevron or another trailing symbol.
struct SettingsRow: View {
    let title: String
    var value: String? = nil
    var symbol = "chevron.right"

    var body: some View {
        HStack(spacing: FatlineStyle.groupGap) {
            Text(title)
                .font(FatlineStyle.body)
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
        .settingsRowFrame()
        .contentShape(.rect)
    }
}

struct SettingsSwitchRow: View {
    let title: String
    @Binding var isOn: Bool
    let id: String

    var body: some View {
        HStack(spacing: FatlineStyle.groupGap) {
            Text(title)
                .font(FatlineStyle.body)
            Spacer(minLength: FatlineStyle.itemGap)
            Toggle(title, isOn: $isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
                .accessibilityIdentifier(id)
        }
        .settingsRowFrame()
    }
}

/// The app's own switches, the same in every Settings, each with a divider under it.
struct AppSwitches: View {
    @Environment(AppState.self) private var state
    @State private var opensAtLogin = LoginItem.isOn

    /// The system can refuse, so the switch shows what it says afterward.
    private var loginBinding: Binding<Bool> {
        Binding(get: { opensAtLogin }, set: { wanted in
            try? LoginItem.set(wanted)
            opensAtLogin = LoginItem.isOn
        })
    }

    var body: some View {
        SettingsSwitchRow(title: "Show in menu bar", isOn: Bindable(state).showsMenuBarIcon, id: "settings-menu-bar")
        CastDivider()
        SettingsSwitchRow(title: "Show in Dock", isOn: Bindable(state).showsDockIcon, id: "settings-dock")
            .disabled(!state.showsMenuBarIcon)
        CastDivider()
        SettingsSwitchRow(title: "Open at login", isOn: loginBinding, id: "settings-login")
        CastDivider()
    }
}

struct SettingsVersion: View {
    var body: some View {
        Text(verbatim: FeedModel.versionLine)
            .font(FatlineStyle.meta)
            .foregroundStyle(FatlineStyle.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, FatlineStyle.gutter)
            .padding(.top, FatlineStyle.gutter)
    }
}

/// Sign Out or Leave, in red at the bottom of Settings.
struct SettingsDangerButton: View {
    let title: String
    var enabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(FatlineStyle.body)
                .foregroundStyle(enabled ? FatlineStyle.danger : FatlineStyle.secondary)
                .frame(maxWidth: .infinity, minHeight: FatlineStyle.regularButtonHeight, alignment: .leading)
                .padding(.horizontal, FatlineStyle.gutter)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}

extension View {
    /// A Settings row: a 40-point control height with 6 above and below, on the gutter.
    func settingsRowFrame() -> some View {
        frame(minHeight: FatlineStyle.regularButtonHeight)
            .padding(.horizontal, FatlineStyle.gutter)
            .padding(.vertical, 6) // layout-ok: makes Settings rows 52, the canvas's row height
    }

    /// Paper runs under the title bar, as it does in the feed window.
    func settingsTitleBar() -> some View {
        toolbarBackground(FatlineStyle.paper, for: .windowToolbar)
            .toolbarBackgroundVisibility(.visible, for: .windowToolbar)
    }
}

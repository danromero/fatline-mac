import SwiftUI

/// Waiting for the admin, or not approved: a mark, a title, one line, and a button at the bottom.
/// Joining shows it, and so does the network's screen while it's in that state.
struct NetworkStatusView: View {
    let status: NetworkMembership.Status
    let host: String
    let button: String
    let action: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            VStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 16) // layout-ok: the empty mark, a 64 tile at the mark's ratio
                    .strokeBorder(FatlineStyle.outline, style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
                    .frame(width: 64, height: 64) // layout-ok: as on the join result
                    .overlay {
                        if status == .pending {
                            Image(systemName: "clock")
                                .font(.system(size: 22)) // layout-ok: a glyph sized to the title
                                .foregroundStyle(FatlineStyle.secondary)
                        }
                    }
                    .accessibilityHidden(true)
                Text(status == .pending ? "Request sent" : "Not approved")
                    .fatlineScreenTitle()
                    .padding(.top, FatlineStyle.gutter)
                Text(status == .pending
                     ? "You’ll be in once the admin of \(host) approves you."
                     : "The admin of \(host) didn’t approve this request.")
                    .font(FatlineStyle.body)
                    .foregroundStyle(FatlineStyle.secondary)
                    .padding(.top, FatlineStyle.castGap)
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
            Button(action: action) {
                Text(button).frame(maxWidth: .infinity)
            }
            .buttonStyle(FatlinePrimaryButton())
            .keyboardShortcut(.defaultAction)
        }
    }
}

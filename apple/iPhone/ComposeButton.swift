import SwiftUI

/// The round plus that floats over a feed, on the trailing gutter. The Farcaster feed and a network's
/// feed both have it.
struct ComposeButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(FatlineStyle.plusGlyph)
                .foregroundStyle(FatlineStyle.actionInk)
                .frame(width: FatlineStyle.plusSize, height: FatlineStyle.plusSize)
                .background(FatlineStyle.action, in: .circle)
        }
        .buttonStyle(FloatingButtonStyle())
        .accessibilityLabel("Compose")
        .accessibilityIdentifier("compose")
        .padding(.trailing, FatlineStyle.gutter)
        .padding(.bottom, FatlineStyle.plusBottom)
    }
}

/// Stays solid while pressed. The plus floats over the feed, and the plain style's fade let the text
/// underneath show through it. The haptic plays on touch-down, ahead of the composer opening on release.
struct FloatingButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.92 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
            .onChange(of: configuration.isPressed) { _, pressed in
                if pressed { Platform.haptic(.tap) }
            }
    }
}

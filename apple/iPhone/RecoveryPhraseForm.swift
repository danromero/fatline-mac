import SwiftUI

struct RecoveryPhraseForm: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var text = ""
    @State private var editing = false
    @State private var validateLength = false
    @State private var oversizedPaste = false
    @State private var pastedClipboard: Int?

    private static let fieldInset: CGFloat = 14

    let busy: Bool
    let error: String?
    let hasPendingRegistration: Bool
    let connect: (String) -> Void
    let retry: () -> Void

    private var words: [Substring] { text.split(whereSeparator: \.isWhitespace) }
    private var validLength: Bool { [12, 24].contains(words.count) }
    private var showMaskedWords: Bool { !editing && !words.isEmpty }
    private var feedback: String? {
        if oversizedPaste { return "Enter 12 or 24 words." }
        if validateLength && !words.isEmpty && !validLength { return "Enter 12 or 24 words." }
        return text.isEmpty ? error : nil
    }

    var body: some View {
        Group {
            if busy {
                importing
            } else {
                form
            }
        }
        .foregroundStyle(FatlineStyle.ink)
        .background(FatlineStyle.paper.ignoresSafeArea())
        .fatlineStepBar()
        .navigationBarBackButtonHidden(busy)
        .toolbar(busy ? .hidden : .visible, for: .navigationBar)
        .overlay {
            if scenePhase != .active {
                FatlineStyle.paper.ignoresSafeArea()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                text = ""
                editing = false
                validateLength = false
                oversizedPaste = false
                pastedClipboard = nil
            }
        }
        .onChange(of: editing) { _, active in
            validateLength = !active
        }
        .onChange(of: error) { _, problem in
            if problem != nil { Platform.haptic(.problem) }
        }
    }

    private var importing: some View {
        let label = Text("Importing…")
            .font(FatlineStyle.bodyStrong)
            .accessibilityIdentifier("recovery-importing")
        return Group {
            if reduceMotion {
                label
            } else {
                label.phaseAnimator([false, true]) { view, dimmed in
                    view.opacity(dimmed ? 0.60 : 1)
                } animation: { _ in
                    .easeInOut(duration: 1.1)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .ignoresSafeArea(.keyboard, edges: .bottom)
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                FatlineStepHeader(
                    title: "Import your account",
                    instruction: "Enter your Farcaster recovery phrase, not another wallet’s."
                )
                VStack(alignment: .leading, spacing: 12) {
                    phraseField
                    if let feedback {
                        Text(feedback)
                            .font(FatlineStyle.meta)
                            .foregroundStyle(FatlineStyle.danger)
                            .accessibilityIdentifier("recovery-error")
                    }
                }
            }
            .padding(.horizontal, FatlineStyle.screenGutter)
            .padding(.top, FatlineStyle.screenTop)
        }
        .fatlineBottomAction { actions }
        .scrollDismissesKeyboard(.interactively)
    }

    private var phraseField: some View {
        VStack(spacing: 4) {
            ZStack(alignment: .topLeading) {
                RecoveryPhraseEntry(text: $text, editing: $editing) { changeCount in
                    oversizedPaste = false
                    if text.isEmpty { pastedClipboard = nil }
                    if let changeCount {
                        pastedClipboard = changeCount
                        // A paste is usually the whole phrase, so mask it the way the Paste button does.
                        editing = false
                    }
                }
                .opacity(showMaskedWords ? 0 : 1)
                .accessibilityHidden(showMaskedWords)
                .allowsHitTesting(!showMaskedWords)

                if text.isEmpty {
                    Text("12 or 24 words")
                        .font(FatlineStyle.body)
                        .foregroundStyle(FatlineStyle.secondary)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }

                if showMaskedWords {
                    Button {
                        editing = true
                    } label: {
                        Text(words.map { _ in "••••" }.joined(separator: "  "))
                            .font(FatlineStyle.body)
                            .lineSpacing(FatlineStyle.bodyLineSpacing)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Edit Farcaster recovery phrase")
                    .accessibilityValue("\(words.count) masked words")
                    .accessibilityIdentifier("recovery-phrase-preview")
                }
            }
            .padding(Self.fieldInset)
            .frame(maxWidth: .infinity, minHeight: 122, alignment: .topLeading)
            .background(FatlineStyle.quiet, in: .rect(cornerRadius: 18))
            RecoveryPasteControl { value, changeCount in
                guard !busy, scenePhase == .active else { return }
                pastedClipboard = nil
                guard value.utf8.count <= 1024 else {
                    text = ""
                    oversizedPaste = true
                    return
                }
                editing = false
                text = value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
                if !text.isEmpty { pastedClipboard = changeCount }
                oversizedPaste = false
                validateLength = true
            }
            .frame(width: 64, height: 44)
        }
    }

    private var actions: some View {
        VStack(spacing: 8) {
            if hasPendingRegistration {
                Button("Retry Connection") {
                    editing = false
                    text = ""
                    pastedClipboard = nil
                    retry()
                }
                .font(FatlineStyle.body)
                .frame(minHeight: 44)
            }
            Button {
                guard validLength else { return }
                Platform.haptic(.tap)
                let phrase = words.joined(separator: " ")
                // Remove only the single clipboard item Fatline pasted, if it is still current.
                let clipboard = UIPasteboard.general
                if clipboard.changeCount == pastedClipboard, clipboard.numberOfItems == 1 {
                    clipboard.items = []
                }
                pastedClipboard = nil
                editing = false
                text = ""
                connect(phrase)
            } label: {
                Text("Import")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(FatlinePrimaryButton())
            .disabled(!validLength)
        }
    }
}

private struct RecoveryPhraseEntry: UIViewRepresentable {
    @Binding var text: String
    @Binding var editing: Bool
    let didEdit: (Int?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> Field {
        let field = Field()
        let font = UIFont(name: "Inter-Regular", size: FatlineStyle.bodySize) ?? .systemFont(ofSize: FatlineStyle.bodySize)
        field.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: font)
        field.adjustsFontForContentSizeCategory = true
        field.textColor = UIColor(FatlineStyle.ink)
        field.tintColor = UIColor(FatlineStyle.action)
        field.backgroundColor = .clear
        field.isScrollEnabled = false
        field.textContainerInset = .zero
        field.textContainer.lineFragmentPadding = 0
        field.isSecureTextEntry = true
        field.keyboardType = .asciiCapable
        field.returnKeyType = .done
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartDashesType = .no
        field.smartQuotesType = .no
        field.smartInsertDeleteType = .no
        field.inlinePredictionType = .no
        field.accessibilityLabel = "Farcaster recovery phrase"
        field.accessibilityHint = "12 or 24 words"
        field.accessibilityIdentifier = "recovery-phrase-entry"
        field.delegate = context.coordinator
        field.pasteDelegate = context.coordinator
        return field
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView field: Field, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let fitted = field.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: fitted.height)
    }

    func updateUIView(_ field: Field, context: Context) {
        context.coordinator.entry = self
        field.show(text)
        if editing != field.isFirstResponder {
            // UIKit calls the delegate when focus changes. Wait until this SwiftUI update ends.
            Task { @MainActor [weak field, weak coordinator = context.coordinator] in
                guard let field, let coordinator, field.window != nil else { return }
                if coordinator.entry.editing {
                    field.becomeFirstResponder()
                } else {
                    field.resignFirstResponder()
                }
            }
        }
    }

    /// Holds only bullets. iOS's secure text field can't wrap, so the phrase stays in `text`.
    final class Field: UITextView {
        var pasteChangeCount: Int?

        override func paste(_ sender: Any?) {
            // UIKit may deliver the pasted text asynchronously through its paste delegate.
            pasteChangeCount = UIPasteboard.general.changeCount
            super.paste(sender)
        }

        /// One bullet per UTF-16 unit, so edit ranges match the phrase. Spaces stay so lines break between words.
        func show(_ phrase: String) {
            let units: [UInt16] = phrase.utf16.map {
                Unicode.Scalar($0)?.properties.isWhitespace == true ? 0x20 : 0x2022
            }
            let mask = String(decoding: units, as: UTF16.self)
            guard mask != text else { return }
            let style = NSMutableParagraphStyle()
            style.lineSpacing = FatlineStyle.bodyLineSpacing
            attributedText = NSAttributedString(string: mask, attributes: [
                .font: font ?? .systemFont(ofSize: FatlineStyle.bodySize),
                .foregroundColor: textColor ?? .label,
                .paragraphStyle: style,
            ])
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate, UITextPasteDelegate {
        var entry: RecoveryPhraseEntry
        private var completedPaste: Int?

        init(_ entry: RecoveryPhraseEntry) { self.entry = entry }

        func textViewDidBeginEditing(_ textView: UITextView) { entry.editing = true }
        func textViewDidEndEditing(_ textView: UITextView) {
            (textView as? Field)?.pasteChangeCount = nil
            completedPaste = nil
            entry.editing = false
        }

        func textPasteConfigurationSupporting(
            _ supporting: any UITextPasteConfigurationSupporting,
            combineItemAttributedStrings strings: [NSAttributedString], for range: UITextRange
        ) -> NSAttributedString {
            if let field = supporting as? Field {
                completedPaste = field.pasteChangeCount
                field.pasteChangeCount = nil
            }
            let combined = NSMutableAttributedString(string: "")
            for string in strings { combined.append(string) }
            return combined
        }

        func textView(
            _ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String
        ) -> Bool {
            if replacement == "\n" {
                textView.resignFirstResponder()
                return false
            }
            let current = entry.text as NSString
            let paste = completedPaste
            completedPaste = nil
            guard let field = textView as? Field, NSMaxRange(range) <= current.length else { return false }
            let updated = current.replacingCharacters(in: range, with: replacement)
            guard updated.utf8.count <= 1024 else { return false }
            // The view must never receive the real text, so apply the edit here and show its mask.
            field.show(updated)
            field.selectedRange = NSRange(location: range.location + (replacement as NSString).length, length: 0)
            field.pasteChangeCount = nil
            entry.text = updated
            entry.didEdit(paste)
            return false
        }
    }
}

private struct RecoveryPasteControl: UIViewRepresentable {
    @Environment(\.isEnabled) private var enabled
    let receive: (String, Int) -> Void

    func makeCoordinator() -> Target { Target(receive: receive) }

    func makeUIView(context: Context) -> UIPasteControl {
        let configuration = UIPasteControl.Configuration()
        configuration.displayMode = .labelOnly
        configuration.baseBackgroundColor = UIColor(FatlineStyle.paper)
        configuration.baseForegroundColor = UIColor(FatlineStyle.secondary)
        let control = UIPasteControl(configuration: configuration)
        control.target = context.coordinator
        return control
    }

    func updateUIView(_ control: UIPasteControl, context: Context) {
        context.coordinator.receive = receive
        control.isUserInteractionEnabled = enabled
    }

    final class Target: UIResponder {
        var receive: (String, Int) -> Void

        init(receive: @escaping (String, Int) -> Void) {
            self.receive = receive
            super.init()
            pasteConfiguration = UIPasteConfiguration(forAccepting: NSString.self)
        }

        override func paste(itemProviders: [NSItemProvider]) {
            let changeCount = UIPasteboard.general.changeCount
            itemProviders.first?.loadObject(ofClass: NSString.self) { [weak self] value, _ in
                guard let text = value as? String else { return }
                Task { @MainActor in self?.receive(text, changeCount) }
            }
        }
    }
}

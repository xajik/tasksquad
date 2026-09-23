import AppKit
import SwiftUI
import TaskSquadCore

struct NativeTerminal: NSViewRepresentable {
    let screen: TerminalScreen
    let enabled: Bool
    let input: (Data) -> Void
    let resize: (Int, Int) -> Void
    func makeNSView(context: Context) -> TerminalScrollView { TerminalScrollView(frame: .zero) }
    func updateNSView(_ scroll: TerminalScrollView, context: Context) {
        let view = scroll.terminal
        view.input = input; view.resized = resize; view.enabled = enabled
        if view.screen != screen { view.screen = screen; view.lines = TerminalANSI.lines(screen.text); view.needsDisplay = true; scroll.needsLayout = true }
    }
}

@MainActor final class TerminalScrollView: NSScrollView {
    let terminal = TerminalCanvas(frame: .zero)
    override init(frame: NSRect) {
        super.init(frame: frame)
        hasHorizontalScroller = true; hasVerticalScroller = true; autohidesScrollers = true
        backgroundColor = NSColor(red: 0.055, green: 0.065, blue: 0.09, alpha: 1)
        documentView = terminal
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layout() {
        super.layout()
        let viewport = contentSize
        terminal.frame.size = NSSize(width: max(viewport.width, CGFloat(terminal.screen?.columns ?? 1) * terminal.cellWidth + 28), height: max(viewport.height, CGFloat(terminal.screen?.rows ?? 1) * terminal.cellHeight + 28))
        terminal.resized?(max(20, Int((viewport.width - 28) / terminal.cellWidth)), max(5, Int((viewport.height - 28) / terminal.cellHeight)))
    }
}

/// Native cell-grid rendering over tmux's own terminal emulator. No WebView,
/// shell interpolation, or replacement of the agent's pipe-pane output capture.
@MainActor final class TerminalCanvas: NSView, @preconcurrency NSTextInputClient {
    var screen: TerminalScreen?
    var lines: [[TerminalSpan]] = []
    var input: ((Data) -> Void)?
    var resized: ((Int, Int) -> Void)?
    var enabled = true
    private var fontSize: CGFloat = 13
    private var font: NSFont { .monospacedSystemFont(ofSize: fontSize, weight: .regular) }
    var cellWidth: CGFloat { ceil(("M" as NSString).size(withAttributes: [.font: font]).width * 100) / 100 }
    var cellHeight: CGFloat { ceil(font.ascender - font.descender + font.leading + 3) }
    private let inset: CGFloat = 14
    private var anchor: (Int, Int)?
    private var selectionEnd: (Int, Int)?
    private var marked = NSAttributedString()
    private let background = NSColor(red: 0.055, green: 0.065, blue: 0.09, alpha: 1)
    private let foreground = NSColor(red: 0.86, green: 0.89, blue: 0.94, alpha: 1)
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true); setAccessibilityRole(.textArea); setAccessibilityLabel("Agent terminal")
        setAccessibilityHelp("Live terminal. Type to interact. Command C copies a selection; Command V pastes. Shift-drag selects text.")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func accessibilityValue() -> Any? { screen.map { TerminalANSI.plain($0.text) } ?? "" }
    override func becomeFirstResponder() -> Bool { needsDisplay = true; return true }
    override func resignFirstResponder() -> Bool { needsDisplay = true; return true }
    override func draw(_ dirtyRect: NSRect) {
        background.setFill(); bounds.fill()
        let first = max(0, Int((dirtyRect.minY - inset) / cellHeight)), last = min(lines.count, Int((dirtyRect.maxY - inset) / cellHeight) + 1)
        guard first < last else { return }
        for row in first..<last {
            var column = 0
            for span in lines[row] {
                var fg = color(span.style.foreground) ?? foreground, bg = color(span.style.background) ?? background
                if span.style.inverse { swap(&fg, &bg) }
                if span.style.dim { fg = fg.withAlphaComponent(0.55) }
                var font = NSFont.monospacedSystemFont(ofSize: fontSize, weight: span.style.bold ? .bold : .regular)
                if span.style.italic { font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask) }
                var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: fg]
                if span.style.underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
                if span.style.strike { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                for character in span.text {
                    let width = TerminalANSI.columns(character)
                    let rect = NSRect(x: inset + CGFloat(column) * cellWidth, y: inset + CGFloat(row) * cellHeight, width: CGFloat(width) * cellWidth, height: cellHeight)
                    if rect.intersects(dirtyRect) {
                        (isSelected(column: column, row: row) ? NSColor.selectedTextBackgroundColor.withAlphaComponent(0.65) : bg).setFill(); rect.fill()
                        (String(character) as NSString).draw(at: NSPoint(x: rect.minX, y: rect.minY + 1), withAttributes: attributes)
                    }
                    column += width
                }
            }
        }
        if let screen, screen.cursorVisible, enabled {
            let rect = NSRect(x: inset + CGFloat(screen.cursorX) * cellWidth, y: inset + CGFloat(screen.cursorY) * cellHeight, width: cellWidth, height: cellHeight)
            if window?.firstResponder === self { foreground.withAlphaComponent(0.35).setFill(); rect.fill() }
            else { foreground.withAlphaComponent(0.4).setStroke(); NSBezierPath(rect: rect.insetBy(dx: 0.5, dy: 0.5)).stroke() }
            if marked.length > 0 { marked.draw(at: NSPoint(x: rect.minX, y: rect.minY)) }
        }
    }
    private func color(_ value: TerminalColor?) -> NSColor? {
        guard let value else { return nil }
        switch value {
        case .rgb(let r, let g, let b): return NSColor(red: CGFloat(max(0, min(255, r))) / 255, green: CGFloat(max(0, min(255, g))) / 255, blue: CGFloat(max(0, min(255, b))) / 255, alpha: 1)
        case .indexed(let raw):
            // A malformed SGR index (e.g. from garbled stdout) can be any Int, not
            // just 0...255; clamp before arithmetic so it can't overflow below.
            let index = max(0, min(255, raw))
            let palette: [UInt32] = [0x24283b, 0xf7768e, 0x9ece6a, 0xe0af68, 0x7aa2f7, 0xbb9af7, 0x7dcfff, 0xc0caf5, 0x565f89, 0xff9eaf, 0xb9f27c, 0xffd580, 0xa9c1ff, 0xd5b8ff, 0xa6edff, 0xf2f4ff]
            if (0..<16).contains(index) { let hex = palette[index]; return color(.rgb(Int(hex >> 16), Int((hex >> 8) & 255), Int(hex & 255))) }
            if (16..<232).contains(index) { let n = index - 16, levels = [0, 95, 135, 175, 215, 255]; return color(.rgb(levels[n / 36], levels[(n / 6) % 6], levels[n % 6])) }
            let gray = max(0, min(255, 8 + (index - 232) * 10)); return color(.rgb(gray, gray, gray))
        }
    }
    override func keyDown(with event: NSEvent) {
        guard enabled else { NSSound.beep(); return }
        anchor = nil; selectionEnd = nil; needsDisplay = true
        let control = event.modifierFlags.contains(.control), option = event.modifierFlags.contains(.option), shift = event.modifierFlags.contains(.shift)
        let modifier = 1 + (shift ? 1 : 0) + (option ? 2 : 0) + (control ? 4 : 0)
        let arrow: [UInt16: String] = [123: "D", 124: "C", 125: "B", 126: "A", 115: "H", 119: "F"]
        if let suffix = arrow[event.keyCode] {
            let value = modifier > 1 ? "\u{1b}[1;\(modifier)\(suffix)" : "\u{1b}\(screen?.applicationCursor == true ? "O" : "[")\(suffix)"
            send(value); return
        }
        let special: [UInt16: String] = [36: "\r", 76: "\r", 48: shift ? "\u{1b}[Z" : "\t", 51: "\u{7f}", 53: "\u{1b}", 117: "\u{1b}[3~", 116: "\u{1b}[5~", 121: "\u{1b}[6~", 122: "\u{1b}OP", 120: "\u{1b}OQ", 99: "\u{1b}OR", 118: "\u{1b}OS", 96: "\u{1b}[15~", 97: "\u{1b}[17~", 98: "\u{1b}[18~", 100: "\u{1b}[19~", 101: "\u{1b}[20~", 109: "\u{1b}[21~", 103: "\u{1b}[23~", 111: "\u{1b}[24~"]
        if let text = special[event.keyCode] { send((option ? "\u{1b}" : "") + text); return }
        if control, let scalar = event.charactersIgnoringModifiers?.lowercased().unicodeScalars.first, scalar.value < 128 {
            let value = scalar.value == 63 ? 127 : scalar.value & 31
            input?(Data((option ? [27] : []) + [UInt8(value)])); return
        }
        if option, let value = event.charactersIgnoringModifiers { send("\u{1b}" + value); return }
        interpretKeyEvents([event])
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self, event.modifierFlags.contains(.command) else { return super.performKeyEquivalent(with: event) }
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "c": copySelection(); return true
        case "v": paste(nil); return true
        case "+", "=": fontSize = min(24, fontSize + 1); enclosingScrollView?.needsLayout = true; needsDisplay = true; return true
        case "-": fontSize = max(9, fontSize - 1); enclosingScrollView?.needsLayout = true; needsDisplay = true; return true
        default: return super.performKeyEquivalent(with: event)
        }
    }
    @objc func paste(_ sender: Any?) {
        guard enabled, let text = NSPasteboard.general.string(forType: .string) else { return }
        if text.utf8.count > 1024 * 1024 { NSSound.beep(); return }
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        if screen?.bracketedPaste == true { send("\u{1b}[200~" + normalized + "\u{1b}[201~") }
        else { send(normalized.replacingOccurrences(of: "\n", with: "\r")) }
    }
    private func send(_ value: String) { if enabled { input?(Data(value.utf8)) } }
    private func location(_ event: NSEvent) -> (Int, Int) {
        let point = convert(event.locationInWindow, from: nil)
        return (max(0, min((screen?.columns ?? 1) - 1, Int((point.x - inset) / cellWidth))), max(0, min(lines.count - 1, Int((point.y - inset) / cellHeight))))
    }
    private func mouse(_ event: NSEvent, release: Bool = false, wheel: Int? = nil) -> Bool {
        guard enabled, let screen, screen.mouse, !event.modifierFlags.contains(.shift) else { return false }
        let (x, y) = location(event), button = wheel ?? (release ? 3 : 0)
        if screen.mouseSGR { send("\u{1b}[<\(wheel ?? 0);\(x + 1);\(y + 1)\(release ? "m" : "M")") }
        else if x < 223 && y < 223 { input?(Data([27, 91, 77, UInt8(button + 32), UInt8(x + 33), UInt8(y + 33)])) }
        return true
    }
    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self); if mouse(event) { return }; anchor = location(event); selectionEnd = anchor; needsDisplay = true }
    override func mouseDragged(with event: NSEvent) { guard anchor != nil else { return }; selectionEnd = location(event); needsDisplay = true }
    override func mouseUp(with event: NSEvent) { if anchor == nil { _ = mouse(event, release: true) } }
    override func scrollWheel(with event: NSEvent) { if !mouse(event, wheel: event.scrollingDeltaY > 0 ? 64 : 65) { super.scrollWheel(with: event) } }
    private func isSelected(column: Int, row: Int) -> Bool {
        guard let anchor, let end = selectionEnd, let screen else { return false }
        let a = anchor.1 * screen.columns + anchor.0, b = end.1 * screen.columns + end.0, position = row * screen.columns + column
        return position >= min(a, b) && position <= max(a, b)
    }
    private func copySelection() {
        guard anchor != nil else { return }
        var text: [String] = []
        for (row, spans) in lines.enumerated() {
            var column = 0, line = "", included = false
            for character in spans.map(\.text).joined() {
                if isSelected(column: column, row: row) { line.append(character); included = true }
                column += TerminalANSI.columns(character)
            }
            if included { text.append(line.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)) }
        }
        copyText(text.joined(separator: "\n"))
    }
    // NSTextInputClient enables composed text and input methods without a hidden web terminal.
    func insertText(_ string: Any, replacementRange: NSRange) { let text = (string as? NSAttributedString)?.string ?? string as? String ?? ""; unmarkText(); send(text) }
    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        marked = NSAttributedString(string: (string as? NSAttributedString)?.string ?? string as? String ?? "", attributes: [.font: font, .foregroundColor: foreground, .backgroundColor: background, .underlineStyle: 1]); needsDisplay = true
    }
    func unmarkText() { marked = NSAttributedString(); needsDisplay = true }
    func selectedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }
    func markedRange() -> NSRange { NSRange(location: marked.length > 0 ? 0 : NSNotFound, length: marked.length) }
    func hasMarkedText() -> Bool { marked.length > 0 }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [.font, .foregroundColor, .backgroundColor, .underlineStyle] }
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        let rect = NSRect(x: inset + CGFloat(screen?.cursorX ?? 0) * cellWidth, y: inset + CGFloat(screen?.cursorY ?? 0) * cellHeight, width: cellWidth, height: cellHeight)
        return window?.convertToScreen(convert(rect, to: nil)) ?? .zero
    }
    func characterIndex(for point: NSPoint) -> Int { 0 }
    override func doCommand(by selector: Selector) { }
}

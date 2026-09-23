import AppKit
import SwiftUI
import TaskSquadCore

struct DocumentPreview: View {
    let url: URL
    @State private var document: PreviewDocument?
    @State private var failure: String?
    @State private var source = false
    @State private var follow = true
    @State private var blocks: [MarkdownBlock] = []
    @State private var nodes: [JSONPreviewNode] = []
    @State private var jsonError: String?
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: document?.isMarkdown == true ? "doc.richtext" : "curlybraces").foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(url.lastPathComponent).font(.headline)
                    Text(url.deletingLastPathComponent().path).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                Spacer()
                if document?.isMarkdown == true || document?.isJSON == true {
                    Picker("Display", selection: $source) { Text("Preview").tag(false); Text("Source").tag(true) }.pickerStyle(.segmented).labelsHidden().frame(width: 150)
                }
                Toggle("Live", isOn: $follow).toggleStyle(.checkbox).help("Refresh when this file changes")
                Button { copyText(document?.text ?? "") } label: { Image(systemName: "doc.on.doc") }.help("Copy source")
                Button { NSWorkspace.shared.activateFileViewerSelecting([url]) } label: { Image(systemName: "folder") }.help("Reveal in Finder")
            }.padding(16)
            Divider()
            if let notice = document?.notice { banner(notice) }
            if let failure { banner(failure) }
            if let document {
                if !source && document.isMarkdown {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) { ForEach(blocks) { MarkdownBlockView(block: $0) } }
                            .textSelection(.enabled).frame(maxWidth: 820, alignment: .leading).padding(32).frame(maxWidth: .infinity)
                    }.background(Color(nsColor: .textBackgroundColor))
                } else if !source && document.isJSON && jsonError == nil { JSONTreeView(nodes: nodes).id(url) }
                else {
                    if let jsonError, !source { banner("Unable to preview JSON: " + jsonError) }
                    if ["log", "txt"].contains(url.pathExtension.lowercased()) { LogPreview(text: document.text) }
                    else { SourceTextView(text: document.text) }
                }
            } else if failure == nil { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
        }
        .task(id: url) {
            document = nil; blocks = []; nodes = []; failure = nil
            var previousDate: Date?
            repeat {
                let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
                if document == nil || date != previousDate { await load(); previousDate = date }
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                while !follow && !Task.isCancelled { do { try await Task.sleep(for: .milliseconds(250)) } catch { return } }
            } while !Task.isCancelled
        }
    }
    private func load() async {
        let target = url
        do {
            let result = try await Task.detached {
                let doc = try PreviewDocument.load(target)
                let markdown = doc.isMarkdown ? MarkdownBlock.parse(doc.text) : []
                var roots: [JSONPreviewNode] = [], error: String?
                if doc.isJSON {
                    do { roots = try JSONPreviewNode.parse(doc.text, lines: target.pathExtension.lowercased() != "json") }
                    catch let failure { error = failure.localizedDescription }
                }
                return (doc, markdown, roots, error)
            }.value
            guard !Task.isCancelled else { return }
            document = result.0; blocks = result.1; nodes = result.2; jsonError = result.3; failure = nil
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }
    private func banner(_ text: String) -> some View {
        Label(text, systemImage: "info.circle").font(.callout).foregroundStyle(.secondary).padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary)
    }
}

struct MarkdownBlockView: View {
    let block: MarkdownBlock
    var body: some View {
        switch block.kind {
        case .heading(let level):
            inline(block.text).font(.system(size: [32.0, 25, 20, 17, 15, 14][level - 1], weight: .semibold)).padding(.top, level <= 2 ? 10 : 4).accessibilityAddTraits(.isHeader)
        case .paragraph: inline(block.text).font(.system(size: 14)).lineSpacing(6)
        case .code(let language):
            VStack(alignment: .leading, spacing: 0) {
                HStack { Text(language.isEmpty ? "Code" : language.uppercased()).font(.caption.weight(.medium)).foregroundStyle(.secondary); Spacer(); Button("Copy") { copyText(block.text) }.buttonStyle(.borderless) }.padding(12)
                Divider()
                ScrollView(.horizontal) { Text(block.text).font(.system(size: 12.5, design: .monospaced)).lineSpacing(4).padding(16).frame(maxWidth: .infinity, alignment: .leading) }
            }.background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
        case .quote:
            HStack(alignment: .top, spacing: 14) { RoundedRectangle(cornerRadius: 2).fill(Color.accentColor.opacity(0.6)).frame(width: 3); inline(block.text).foregroundStyle(.secondary).lineSpacing(5).padding(.vertical, 10) }.fixedSize(horizontal: false, vertical: true).padding(.leading, 4)
        case .list(let marker, let indent):
            HStack(alignment: .firstTextBaseline, spacing: 10) { Text(marker).foregroundStyle(.secondary).frame(minWidth: 16, alignment: .trailing); inline(block.text).lineSpacing(4) }.padding(.leading, CGFloat(indent * 20))
        case .task(let checked, let indent):
            HStack(alignment: .firstTextBaseline, spacing: 10) { Image(systemName: checked ? "checkmark.circle.fill" : "circle").foregroundStyle(checked ? Color.green : Color.secondary); inline(block.text).lineSpacing(4) }.padding(.leading, CGFloat(indent * 20))
        case .rule: Divider().padding(.vertical, 8)
        case .table:
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    ForEach(Array(block.rows.enumerated()), id: \.offset) { index, row in
                        GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, cell in inline(cell).fontWeight(index == 0 ? .semibold : .regular).padding(.vertical, 10).padding(.horizontal, 12) } }
                            .background(index == 0 ? Color.accentColor.opacity(0.08) : Color.clear)
                        Divider().gridCellUnsizedAxes(.horizontal)
                    }
                }.clipShape(RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary))
            }
        }
    }
    private func inline(_ source: String) -> Text {
        var attributed = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
        for run in attributed.runs {
            if run.inlinePresentationIntent?.contains(.code) == true { attributed[run.range].font = .system(size: 13, design: .monospaced); attributed[run.range].foregroundColor = .purple }
            if let link = run.link, !["https", "http", "mailto"].contains(link.scheme?.lowercased() ?? "") { attributed[run.range].link = nil }
        }
        return Text(attributed)
    }
}

struct JSONTreeView: View {
    let nodes: [JSONPreviewNode]
    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded: Set<String> = []
    @State private var search = ""
    private struct Row: Identifiable { var id: String { node.id }; let node: JSONPreviewNode; let depth: Int }
    private var rows: [Row] {
        var rows: [Row] = []
        func visit(_ node: JSONPreviewNode, depth: Int) {
            if !search.isEmpty {
                if node.label.localizedCaseInsensitiveContains(search) || (!node.isContainer && node.value.localizedCaseInsensitiveContains(search)) { rows.append(Row(node: node, depth: depth)) }
                for child in node.children { visit(child, depth: depth + 1) }
            } else {
                rows.append(Row(node: node, depth: depth))
                if expanded.contains(node.id) { for child in node.children { visit(child, depth: depth + 1) } }
            }
        }
        nodes.forEach { visit($0, depth: 0) }; return rows
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Find a key or value", text: $search).textFieldStyle(.plain)
                Button("Collapse All") { expanded.removeAll() }.buttonStyle(.borderless)
            }.padding(14)
            Divider()
            GeometryReader { geometry in
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(rows) { row in
                        HStack(alignment: .top, spacing: 10) {
                            if row.node.isContainer {
                                Button { if !expanded.insert(row.id).inserted { expanded.remove(row.id) } } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: expanded.contains(row.id) ? "chevron.down" : "chevron.right")
                                            .font(.system(size: 10, weight: .semibold)).frame(width: 28, height: 32)
                                        Text(row.node.label).fontWeight(.medium).frame(width: 150, alignment: .leading).lineLimit(2)
                                    }.contentShape(Rectangle())
                                }.buttonStyle(.plain).help(row.node.label).accessibilityLabel("Toggle \(row.node.label)")
                                    .accessibilityValue(expanded.contains(row.id) ? "Expanded" : "Collapsed")
                            } else {
                                Color.clear.frame(width: 28, height: 32)
                                Text(row.node.label).fontWeight(.medium).foregroundStyle(.primary).frame(width: 150, alignment: .leading).lineLimit(2).help(row.node.label)
                            }
                            Text(row.node.isContainer ? (row.node.kind == .object ? "{ }" : "[ ]") : ":").foregroundStyle(.tertiary)
                            Text(row.node.value).foregroundStyle(color(row.node.kind)).textSelection(.enabled).lineLimit(expanded.contains(row.id) ? nil : 4)
                            Spacer(minLength: 16)
                            Text(row.node.kind.rawValue).font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary).padding(.horizontal, 6).padding(.vertical, 2).background(.quaternary, in: Capsule())
                        }.font(.system(size: 12.5, design: .monospaced)).padding(.vertical, 4).padding(.trailing, 18).padding(.leading, CGFloat(12 + row.depth * 20))
                            .background(row.depth == 0 ? Color.accentColor.opacity(0.05) : Color.clear)
                            .contextMenu {
                                Button("Copy Value") { copyText(row.node.raw) }
                                if row.node.kind == .string { Button("Copy Text") { copyText(row.node.value) }; Button("Expand Text") { expanded.insert(row.id) } }
                            }
                    }
                }.frame(width: max(600, geometry.size.width), alignment: .leading)
                    .frame(minHeight: max(0, geometry.size.height - 20), alignment: .topLeading)
                    .padding(.vertical, 10)
            }.background(Color(nsColor: .textBackgroundColor))
            }
        }.background(Color(nsColor: .textBackgroundColor)).onAppear { expanded = Set(nodes.prefix(1).map(\.id)) }
    }
    private func color(_ kind: JSONPreviewNode.Kind) -> Color {
        switch kind {
        case .string: colorScheme == .dark ? Color(red: 0.45, green: 0.84, blue: 0.77) : Color(red: 0.05, green: 0.40, blue: 0.35)
        case .number: colorScheme == .dark ? Color(red: 1, green: 0.72, blue: 0.40) : Color(red: 0.65, green: 0.29, blue: 0.05)
        case .boolean: .purple; case .invalid: .red; default: .secondary
        }
    }
}

private struct LogPreview: View {
    let text: String
    @State private var query = ""
    private var lines: [Substring] { text.split(separator: "\n", omittingEmptySubsequences: false) }
    private var filtered: String { query.isEmpty ? text : lines.filter { $0.localizedCaseInsensitiveContains(query) }.joined(separator: "\n") }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Filter log output", text: $query).textFieldStyle(.plain)
                Text("\(lines.count) lines").font(.caption).foregroundStyle(.secondary)
            }.padding(14)
            Divider()
            SourceTextView(text: filtered, highlightsLog: true)
        }
    }
}

struct SourceTextView: NSViewRepresentable {
    let text: String
    var highlightsLog = false
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = true; scroll.autohidesScrollers = true
        let view = NSTextView(); view.isEditable = false; view.isSelectable = true; view.isRichText = false
        view.font = .monospacedSystemFont(ofSize: 12, weight: .regular); view.textColor = .textColor
        view.textContainerInset = NSSize(width: 20, height: 16); view.isHorizontallyResizable = true; view.isVerticallyResizable = true
        view.autoresizingMask = [.width]; view.textContainer?.widthTracksTextView = false; view.textContainer?.containerSize = NSSize(width: 100_000, height: CGFloat.greatestFiniteMagnitude)
        scroll.documentView = view; return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView, view.string != text else { return }
        let bottom = scroll.documentVisibleRect.maxY >= view.bounds.height - 30
        let selection = view.selectedRange()
        if highlightsLog {
            // Use the one shared ANSI stripper (also used by the live terminal view
            // and run-log writer) instead of a third, narrower regex that only
            // covered CSI sequences and left OSC/charset-designator bytes in text
            // that would otherwise render clean elsewhere.
            let cleaned = TerminalANSI.plain(text)
            let attributed = NSMutableAttributedString(string: cleaned, attributes: [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: NSColor.textColor])
            let regex = try? NSRegularExpression(pattern: #"(?m)^.*\b(ERROR|WARN|DEBUG|INFO|EVENT)\b.*$"#)
            let ns = cleaned as NSString
            for match in regex?.matches(in: cleaned, range: NSRange(location: 0, length: ns.length)) ?? [] {
                let level = ns.substring(with: match.range(at: 1))
                let color: NSColor = level == "ERROR" ? .systemRed : level == "WARN" ? .systemOrange : level == "DEBUG" ? .secondaryLabelColor : level == "EVENT" ? .systemPurple : .textColor
                attributed.addAttribute(.foregroundColor, value: color, range: match.range)
            }
            view.textStorage?.setAttributedString(attributed)
        } else { view.string = text }
        view.setSelectedRange(NSRange(location: min(selection.location, (view.string as NSString).length), length: 0))
        if bottom { view.scrollToEndOfDocument(nil) }
    }
}
func copyText(_ text: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }

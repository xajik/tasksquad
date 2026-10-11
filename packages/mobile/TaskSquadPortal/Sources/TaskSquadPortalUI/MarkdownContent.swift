import SwiftUI
import TaskSquadPortal
import TaskSquadDesign

public struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let copy: ((String) -> Void)?
    public init(block: MarkdownBlock, copy: ((String) -> Void)? = nil) { self.block = block; self.copy = copy }
    public var body: some View {
        switch block.kind {
        case .heading(let level):
            inline(block.text).font(.system(size: [32.0, 25, 20, 17, 15, 14][level - 1], weight: .semibold)).padding(.top, level <= 2 ? 10 : 4).accessibilityAddTraits(.isHeader)
        case .paragraph: inline(block.text).font(TSQTheme.body).lineSpacing(6)
        case .code(let language):
            VStack(alignment: .leading, spacing: 0) {
                HStack { Text(language.isEmpty ? "Code" : language.uppercased()).font(TSQTheme.caption.weight(.medium)).foregroundStyle(TSQTheme.mutedForeground); Spacer(); if let copy { Button("Copy") { copy(block.text) }.buttonStyle(.borderless) } }.padding(12)
                Divider()
                ScrollView(.horizontal) { Text(block.text).font(.system(size: 12.5, design: .monospaced)).lineSpacing(4).padding(16).frame(maxWidth: .infinity, alignment: .leading) }
            }.background(TSQTheme.muted).clipShape(RoundedRectangle(cornerRadius: TSQTheme.controlRadius)).overlay(RoundedRectangle(cornerRadius: TSQTheme.controlRadius).strokeBorder(TSQTheme.border))
        case .quote:
            HStack(alignment: .top, spacing: 14) { RoundedRectangle(cornerRadius: 2).fill(TSQTheme.border).frame(width: 3); inline(block.text).foregroundStyle(TSQTheme.mutedForeground).lineSpacing(5).padding(.vertical, 10) }.fixedSize(horizontal: false, vertical: true).padding(.leading, 4)
        case .list(let marker, let indent):
            HStack(alignment: .firstTextBaseline, spacing: 10) { Text(marker).foregroundStyle(TSQTheme.mutedForeground).frame(minWidth: 16, alignment: .trailing); inline(block.text).lineSpacing(4) }.padding(.leading, CGFloat(indent * 20))
        case .task(let checked, let indent):
            HStack(alignment: .firstTextBaseline, spacing: 10) { Image(systemName: checked ? "checkmark.circle" : "circle").foregroundStyle(checked ? TSQTheme.green : TSQTheme.mutedForeground).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }; inline(block.text).lineSpacing(4) }.padding(.leading, CGFloat(indent * 20))
        case .rule: Divider().padding(.vertical, 8)
        case .table:
            ScrollView(.horizontal) {
                Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                    ForEach(Array(block.rows.enumerated()), id: \.offset) { index, row in
                        GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                            // Each cell fills its column so the header tint spans the whole row.
                            inline(cell).fontWeight(index == 0 ? .semibold : .regular).padding(.vertical, 10).padding(.horizontal, 12)
                                .frame(maxWidth: .infinity, alignment: .leading).background(index == 0 ? TSQTheme.muted : Color.clear)
                        } }
                        Divider().gridCellUnsizedAxes(.horizontal)
                    }
                }.clipShape(RoundedRectangle(cornerRadius: TSQTheme.radius)).overlay(RoundedRectangle(cornerRadius: TSQTheme.radius).strokeBorder(TSQTheme.border))
            }
        }
    }
    private func inline(_ source: String) -> Text {
        var attributed = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
        for run in attributed.runs {
            if run.inlinePresentationIntent?.contains(.code) == true { attributed[run.range].font = .system(size: 13, design: .monospaced); attributed[run.range].foregroundColor = TSQTheme.foreground }
            if let link = run.link, !["https", "http", "mailto"].contains(link.scheme?.lowercased() ?? "") { attributed[run.range].link = nil }
        }
        return Text(attributed)
    }
}

public struct MarkdownContent: View {
    let blocks: [MarkdownBlock]
    let copy: ((String) -> Void)?
    public init(_ source: String, copy: ((String) -> Void)? = nil) { blocks = MarkdownBlock.parse(source); self.copy = copy }
    public var body: some View {
        VStack(alignment: .leading, spacing: 8) { ForEach(blocks) { MarkdownBlockView(block: $0, copy: copy) } }
            .font(TSQTheme.body).foregroundStyle(TSQTheme.foreground).textSelection(.enabled)
    }
}

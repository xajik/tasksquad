import React from 'react'
import { type TranscriptEntry, TranscriptParser } from './transcript/base'
import { claudeParser } from './transcript/claude'
import { geminiParser } from './transcript/gemini'

function dispatchRender(entries: TranscriptEntry[], registry: any, rawContent?: string): React.ReactNode[] {
  const results: React.ReactNode[] = []
  entries.forEach((entry, i) => {
    const renderer = registry[entry.type]
    if (renderer) {
      const rendered = renderer(entry, i, rawContent)
      if (rendered) results.push(rendered)
    }
  })
  return results
}

export const parsers: TranscriptParser[] = [
  claudeParser,
  geminiParser,
  {
    name: 'text',
    canParse: () => true,
    parse: () => [],
    getRenderers: () => ({
      _raw: (_entry: TranscriptEntry, _i: number, rawContent?: string) => (
        <pre className="text-xs font-mono leading-relaxed whitespace-pre text-foreground/90 bg-muted/20 rounded-lg p-4 border border-border/40">{rawContent || ''}</pre>
      ),
    }),
  },
]

export function parseTranscript(content: string): React.ReactNode {
  const trimmed = content.trim()
  if (!trimmed) return <pre className="text-xs font-mono text-muted-foreground">(empty transcript)</pre>

  for (const parser of parsers) {
    if (parser.canParse(trimmed)) {
      const entries = parser.parse(trimmed)
      const registry = parser.getRenderers(entries)
      const results = dispatchRender(entries, registry, trimmed)
      if (results.length > 0) return <div className="space-y-6 pb-4">{results}</div>
    }
  }
  
  return <pre className="text-xs font-mono leading-relaxed whitespace-pre text-foreground/90 bg-muted/20 rounded-lg p-4 border border-border/40">{trimmed}</pre>
}

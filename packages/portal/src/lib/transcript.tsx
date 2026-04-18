import { useState } from 'react'
import { Terminal, ChevronUp, ChevronDown, Code2, ExternalLink, Brain } from 'lucide-react'

export interface TranscriptEntry {
  type: string
  message?: {
    role?: string
    content?: string | Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: string
      is_error?: boolean
    }>
  }
  tool_use_id?: string
  content?: string | any[]
  result?: string
  total_cost_usd?: number
  toolUseResult?: {
    stdout?: string
    stderr?: string
    is_error?: boolean
  }
  attachment?: {
    type?: string
    hookName?: string
    stdout?: string
    stderr?: string
    exitCode?: number
  }
  subtype?: string
  hookCount?: number
  durationMs?: number
  timestamp?: string
  cwd?: string
  // Gemini specific
  id?: string
  thoughts?: Array<{
    subject: string
    description: string
    timestamp: string
  }>
  tokens?: {
    input: number
    output: number
    cached?: number
    thoughts?: number
    tool?: number
    total: number
  }
  model?: string
  toolCalls?: Array<{
    id: string
    name: string
    args: any
    result?: any
    status?: string
    timestamp?: string
    resultDisplay?: {
      summary: string
      files?: string[]
    }
    description?: string
    displayName?: string
    renderOutputAsMarkdown?: boolean
  }>
}

type EntryRenderer = (entry: TranscriptEntry, index: number, rawContent?: string) => React.ReactNode | null

type RendererRegistry = Record<string, EntryRenderer>

function parseJsonl(content: string): TranscriptEntry[] {
  return content.trim().split('\n')
    .filter(l => l.trim())
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter((e): e is TranscriptEntry => e !== null)
}

function dispatchRender(entries: TranscriptEntry[], registry: RendererRegistry, rawContent?: string): React.ReactNode[] {
  const results: React.ReactNode[] = []
  
  const toolUseResults: Record<string, TranscriptEntry['toolUseResult']> = {}
  
  entries.forEach(e => {
    if (e.toolUseResult && e.tool_use_id) toolUseResults[e.tool_use_id] = e.toolUseResult
  })
  
  entries.forEach((entry, i) => {
    const renderer = registry[entry.type]
    if (renderer) {
      const rendered = renderer(entry, i, rawContent)
      if (rendered) results.push(rendered)
    }
  })
  
  return results
}

function ToolExecution({ name, input, output, isError }: { name: string; input: unknown; output?: string; isError?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  
  return (
    <div className="border border-border/60 rounded-lg overflow-hidden my-2 bg-muted/20">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-xs font-medium"
      >
        <Terminal className="h-3 w-3 text-muted-foreground" />
        <span className="text-muted-foreground italic">use tool</span>
        <span className="font-mono text-foreground">{name}</span>
        <div className="flex-1" />
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      
      {expanded && (
        <div className="p-3 pt-0 space-y-3">
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
              <Code2 className="h-2.5 w-2.5" /> Input
            </div>
            <pre className="text-[11px] bg-zinc-950 text-emerald-400/90 p-2 rounded border border-white/5 overflow-auto max-h-40">
              {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
            </pre>
          </div>
          {output && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                <ExternalLink className="h-2.5 w-2.5" /> Output
              </div>
              <pre className={`text-[11px] p-2 rounded border border-white/5 overflow-auto max-h-60 ${isError ? 'bg-zinc-900 text-red-400' : 'bg-zinc-900 text-zinc-300'}`}>
                {output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function createClaudeRenderers(): RendererRegistry {
  const toolUseResults: Record<string, TranscriptEntry['toolUseResult']> = {}
  
  return {
    user: (entry, i) => {
      const raw = entry.message?.content
      let text: string | undefined
      
      if (typeof raw === 'string') {
        text = raw
      } else if (Array.isArray(raw)) {
        const textBlock = raw.find(c => c.type === 'text')
        text = textBlock?.text
        const toolResults = raw.filter(c => c.type === 'tool_result')
        if (toolResults.length > 0) {
          return (
            <div key={i} className="space-y-2">
              <div className="text-[10px] uppercase tracking-widest font-bold text-blue-500/80">Human</div>
              {text && <div className="text-sm leading-relaxed whitespace-pre-wrap pl-3 border-l-2 border-blue-500/20">{text}</div>}
              {toolResults.map((tr, j) => (
                <div key={j} className="ml-3 p-2 rounded bg-zinc-900 border border-zinc-700">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-semibold mb-1">Tool Result</div>
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">{tr.content}</pre>
                </div>
              ))}
            </div>
          )
        }
      }
      if (!text) return null
      return (
        <div key={i} className="space-y-1">
          <div className="text-[10px] uppercase tracking-widest font-bold text-blue-500/80">Human</div>
          <div className="text-sm leading-relaxed whitespace-pre-wrap pl-3 border-l-2 border-blue-500/20">{text}</div>
        </div>
      )
    },
    
    assistant: (entry, i) => {
      const content = entry.message?.content
      if (!content) return null
      
      const contentEls: React.ReactNode[] = []
      
      if (Array.isArray(content)) {
        content.forEach((c, j) => {
          if (c.type === 'text' && c.text) {
            contentEls.push(<div key={j} className="text-sm leading-relaxed whitespace-pre">{c.text}</div>)
          }
          if (c.type === 'tool_use' && c.name && c.input) {
            const toolId = c.tool_use_id || c.name
            contentEls.push(<ToolExecution key={j} name={c.name} input={c.input} output={toolUseResults[toolId]?.stdout} isError={toolUseResults[toolId]?.is_error} />)
          }
        })
      } else if (typeof content === 'string' && content) {
        contentEls.push(<div key={0} className="text-sm leading-relaxed whitespace-pre">{content}</div>)
      }
      
      if (contentEls.length === 0) return null
      
      return (
        <div key={i} className="space-y-3">
          <div className="text-[10px] uppercase tracking-widest font-bold text-emerald-600/80">Claude</div>
          <div className="space-y-2 pl-3 border-l-2 border-emerald-500/20">{contentEls}</div>
        </div>
      )
    },
    
    attachment: (entry, i) => {
      if (!entry.attachment) return null
      return <div key={i} className="text-[10px] text-muted-foreground/60 italic">Hook: {entry.attachment.hookName}</div>
    },
    
    system: (entry, i) => {
      if (entry.subtype === 'turn_duration') {
        return <div key={i} className="text-xs text-muted-foreground/50 border-t border-border/30 pt-2">Turn duration: {entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : '—'}</div>
      }
      if (entry.subtype === 'stop_hook_summary') {
        return <div key={i} className="text-xs text-muted-foreground/50">Hooks executed: {entry.hookCount}</div>
      }
      return null
    },
    
    'permission-mode': () => null,
    'file-history-snapshot': () => null,
  }
}

function ThoughtsSection({ thoughts }: { thoughts: Array<{ subject: string; description: string }> }) {
  const [expanded, setExpanded] = useState(false)
  
  return (
    <div className="border border-indigo-500/20 rounded-lg overflow-hidden my-2 bg-indigo-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-indigo-500/10 transition-colors text-[11px] font-medium text-left"
      >
        <Brain className="h-3.5 w-3.5 text-indigo-500/70" />
        <span className="text-indigo-500/70 italic">reasoning</span>
        <div className="flex-1" />
        {expanded ? <ChevronUp className="h-3.5 w-3.5 text-indigo-500/40" /> : <ChevronDown className="h-3.5 w-3.5 text-indigo-500/40" />}
      </button>
      
      {expanded && (
        <div className="p-3 pt-0 space-y-3">
          {thoughts.map((thought, j) => (
            <div key={j} className="text-[11px] border-l border-indigo-500/20 pl-3">
              <div className="font-bold text-indigo-600/70 mb-0.5">{thought.subject}</div>
              <div className="text-muted-foreground leading-relaxed">{thought.description}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function createGeminiRenderers(): RendererRegistry {
  return {
    user: (entry, i) => {
      let text = ''
      if (typeof entry.content === 'string') {
        text = entry.content
      } else if (Array.isArray(entry.content)) {
        text = entry.content.map((c: any) => c.text || '').join('\n')
      }
      
      if (!text) return null
      
      return (
        <div key={entry.id || i} className="space-y-1">
          <div className="text-[10px] uppercase tracking-widest font-bold text-blue-500/80">Human</div>
          <div className="text-sm leading-relaxed whitespace-pre-wrap pl-3 border-l-2 border-blue-500/20">{text}</div>
        </div>
      )
    },
    
    gemini: (entry, i) => {
      const content = entry.content
      const thoughts = entry.thoughts
      const toolCalls = entry.toolCalls
      
      const contentEls: React.ReactNode[] = []
      
      if (thoughts && thoughts.length > 0) {
        contentEls.push(<ThoughtsSection key="thoughts" thoughts={thoughts} />)
      }

      if (typeof content === 'string' && content) {
        contentEls.push(<div key="text" className="text-sm leading-relaxed whitespace-pre-wrap">{content}</div>)
      } else if (Array.isArray(content)) {
        const text = content.map((c: any) => c.text || '').join('\n')
        if (text) contentEls.push(<div key="text" className="text-sm leading-relaxed whitespace-pre-wrap">{text}</div>)
      }
      
      if (toolCalls && toolCalls.length > 0) {
        toolCalls.forEach((tc, j) => {
          let output = ''
          if (tc.result) {
            if (Array.isArray(tc.result)) {
              output = tc.result.map((r: any) => {
                if (r.functionResponse?.response?.output) return r.functionResponse.response.output
                return JSON.stringify(r, null, 2)
              }).join('\n')
            } else {
              output = JSON.stringify(tc.result, null, 2)
            }
          }
          contentEls.push(<ToolExecution key={`tool-${j}`} name={tc.displayName || tc.name} input={tc.args} output={output} isError={tc.status === 'error'} />)
        })
      }
      
      if (entry.tokens) {
        contentEls.push(
          <div key="tokens" className="flex items-center gap-4 pt-2 border-t border-border/10 mt-2">
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="font-semibold text-muted-foreground/80">In:</span> {entry.tokens.input}
            </div>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className="font-semibold text-muted-foreground/80">Out:</span> {entry.tokens.output}
            </div>
            {entry.tokens.cached ? (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="font-semibold text-muted-foreground/80">Cached:</span> {entry.tokens.cached}
              </div>
            ) : null}
            <div className="flex-1" />
            <div className="text-[10px] text-muted-foreground/60">Total: {entry.tokens.total}</div>
          </div>
        )
      }

      if (contentEls.length === 0) return null
      
      return (
        <div key={entry.id || i} className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-[10px] uppercase tracking-widest font-bold text-indigo-600/80">Gemini</div>
            {entry.model && <div className="text-[9px] text-muted-foreground/60 px-1 border border-border/40 rounded bg-muted/30">{entry.model}</div>}
          </div>
          <div className="space-y-2 pl-3 border-l-2 border-indigo-500/20">{contentEls}</div>
        </div>
      )
    }
  }
}

export const parsers: TranscriptParser[] = [
  {
    name: 'claude',
    canParse: (content: string) => {
      const trimmed = content.trim()
      if (!trimmed) return false
      try {
        const firstLine = JSON.parse(trimmed.split('\n')[0])
        return typeof firstLine === 'object' && firstLine !== null && 'type' in firstLine
      } catch {
        return false
      }
    },
    parse: parseJsonl,
    getRenderers: createClaudeRenderers,
  },
  {
    name: 'gemini',
    canParse: (content: string) => {
      const trimmed = content.trim()
      if (!trimmed) return false
      try {
        const parsed = JSON.parse(trimmed)
        return parsed && parsed.kind === 'main' && Array.isArray(parsed.messages)
      } catch {
        return false
      }
    },
    parse: (content: string) => {
      try {
        const parsed = JSON.parse(content)
        return parsed.messages.map((m: any) => ({
          ...m,
          type: m.type === 'user' ? 'user' : 'gemini',
        }))
      } catch {
        return []
      }
    },
    getRenderers: createGeminiRenderers,
  },
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

export interface TranscriptParser {
  name: string
  canParse: (content: string) => boolean
  parse: (content: string) => TranscriptEntry[]
  getRenderers: (entries: TranscriptEntry[]) => RendererRegistry
}

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
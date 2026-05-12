import React from 'react'
import { ChevronUp, ChevronDown, Terminal, Code2 } from 'lucide-react'
import { TranscriptEntry, RendererRegistry } from './base'

// ── PI session-format types ───────────────────────────────────────────────────
// https://pi.dev/docs/latest/session-format

type PiTextBlock      = { type: 'text'; text: string }
type PiThinkingBlock  = { type: 'thinking'; thinking: string }
type PiToolCallBlock  = { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
type PiImageBlock     = { type: 'image'; data: string; mimeType: string }
type PiContentBlock   = PiTextBlock | PiThinkingBlock | PiToolCallBlock | PiImageBlock

type PiContent = string | PiContentBlock[]

interface PiUserMessage {
  role: 'user'
  content: PiContent
  timestamp?: number
}

interface PiAssistantMessage {
  role: 'assistant'
  content: PiContentBlock[]
  model?: string
  provider?: string
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  errorMessage?: string
  usage?: {
    input?: number
    output?: number
    totalTokens?: number
    cost?: { total?: number }
  }
  timestamp?: number
}

interface PiToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: PiContentBlock[]
  isError: boolean
  timestamp?: number
}

interface PiBashExecutionMessage {
  role: 'bashExecution'
  command: string
  output: string
  exitCode: number
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
  timestamp?: number
}

interface PiCompactionSummaryMessage {
  role: 'compactionSummary'
  summary: string
  tokensBefore?: number
}

interface PiBranchSummaryMessage {
  role: 'branchSummary'
  summary: string
  fromId?: string
}

type PiMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage
  | PiCompactionSummaryMessage
  | PiBranchSummaryMessage
  | { role: 'custom'; customType?: string; content?: PiContent; display?: boolean }

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTextContent(content: PiContent | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((b): b is PiTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="border border-indigo-500/20 rounded-lg overflow-hidden my-1 bg-indigo-500/5">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-indigo-500/10 transition-colors text-[11px] text-left"
      >
        <span className="text-indigo-500/70 italic">thinking</span>
        <div className="flex-1" />
        {open ? <ChevronUp className="h-3 w-3 text-indigo-500/40" /> : <ChevronDown className="h-3 w-3 text-indigo-500/40" />}
      </button>
      {open && (
        <div className="px-3 pb-2 text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap border-t border-indigo-500/10">
          {text}
        </div>
      )}
    </div>
  )
}

function ToolCallBlock({ name, args, result }: {
  name: string
  args: Record<string, unknown>
  result?: { content: string; isError: boolean }
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <div className="border border-border/60 rounded-lg overflow-hidden my-2 bg-muted/20">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-xs font-medium"
      >
        <Terminal className="h-3 w-3 text-muted-foreground" />
        <span className="text-muted-foreground italic">use tool</span>
        <span className="font-mono text-foreground">{name}</span>
        <div className="flex-1" />
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {open && (
        <div className="p-3 pt-0 space-y-3">
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
              <Code2 className="h-2.5 w-2.5" /> Arguments
            </div>
            <pre className="text-[11px] bg-zinc-950 text-emerald-400/90 p-2 rounded border border-white/5 overflow-auto max-h-40">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
          {result && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Result
              </div>
              <pre className={`text-[11px] p-2 rounded border border-white/5 overflow-auto max-h-60 ${result.isError ? 'bg-zinc-900 text-red-400' : 'bg-zinc-900 text-zinc-300'}`}>
                {result.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BashBlock({ command, output, exitCode, truncated }: {
  command: string; output: string; exitCode: number; truncated: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const isError = exitCode !== 0
  return (
    <div className="border border-border/60 rounded-lg overflow-hidden my-2 bg-muted/20">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-xs font-medium"
      >
        <Terminal className="h-3 w-3 text-muted-foreground" />
        <span className="text-muted-foreground italic">bash</span>
        <span className="font-mono text-foreground truncate max-w-[60%]">{command}</span>
        <div className="flex-1" />
        <span className={`text-[10px] font-mono ${isError ? 'text-red-400' : 'text-emerald-400'}`}>
          exit {exitCode}
        </span>
        {open ? <ChevronUp className="h-3 w-3 ml-1" /> : <ChevronDown className="h-3 w-3 ml-1" />}
      </button>
      {open && output && (
        <div className="p-3 pt-0 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Output{truncated ? ' (truncated)' : ''}</div>
          <pre className={`text-[11px] p-2 rounded border border-white/5 overflow-auto max-h-60 ${isError ? 'bg-zinc-900 text-red-400' : 'bg-zinc-900 text-zinc-300'}`}>
            {output}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── Renderer factory ──────────────────────────────────────────────────────────

function createPiRenderers(
  toolResults: Record<string, { content: string; isError: boolean }>
): RendererRegistry {
  return {
    // Non-message entry types
    session:               () => null,
    label:                 () => null,
    session_info:          () => null,
    custom:                () => null,
    thinking_level_change: () => null,

    model_change: (entry, i) => {
      const e = entry as any
      return (
        <div key={i} className="text-[10px] text-muted-foreground/50 italic py-1">
          Model switched to {e.provider && `${e.provider}/`}{e.modelId}
        </div>
      )
    },

    compaction: (entry, i) => {
      const e = entry as any
      return (
        <div key={i} className="my-2 px-3 py-2 rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-600/70">
          <span className="font-semibold">Context compacted</span>
          {e.summary && <span className="ml-1 text-muted-foreground">— {e.summary}</span>}
          {e.tokensBefore && <span className="ml-1">({e.tokensBefore.toLocaleString()} tokens before)</span>}
        </div>
      )
    },

    branch_summary: (entry, i) => {
      const e = entry as any
      return (
        <div key={i} className="my-2 px-3 py-2 rounded-lg border border-dashed border-blue-500/20 bg-blue-500/5 text-[11px] text-blue-600/70">
          <span className="font-semibold">Branch summary</span>
          {e.summary && <span className="ml-1 text-muted-foreground">— {e.summary}</span>}
        </div>
      )
    },

    custom_message: (entry, i) => {
      const e = entry as any
      if (!e.display) return null
      const text = extractTextContent(e.content)
      if (!text) return null
      return (
        <div key={i} className="text-[11px] text-muted-foreground/70 italic pl-3 border-l-2 border-border/40">
          {text}
        </div>
      )
    },

    // Main message entry — dispatches by role
    message: (entry, i) => {
      const msg = (entry as any).message as PiMessage | undefined
      if (!msg) return null

      if (msg.role === 'user') {
        const text = extractTextContent(msg.content)
        if (!text) return null
        return (
          <div key={i} className="space-y-1">
            <div className="text-[10px] uppercase tracking-widest font-bold text-blue-500/80">Human</div>
            <div className="text-sm leading-relaxed whitespace-pre-wrap pl-3 border-l-2 border-blue-500/20">{text}</div>
          </div>
        )
      }

      if (msg.role === 'assistant') {
        const am = msg as PiAssistantMessage
        const els: React.ReactNode[] = []
        for (const [j, block] of am.content.entries()) {
          if (block.type === 'text' && block.text) {
            els.push(<div key={j} className="text-sm leading-relaxed whitespace-pre-wrap">{block.text}</div>)
          } else if (block.type === 'thinking' && block.thinking) {
            els.push(<ThinkingBlock key={j} text={block.thinking} />)
          } else if (block.type === 'toolCall') {
            els.push(
              <ToolCallBlock
                key={j}
                name={block.name}
                args={block.arguments}
                result={toolResults[block.id]}
              />
            )
          }
        }
        if (els.length === 0) return null
        const meta = am.usage?.cost?.total
          ? `$${am.usage.cost.total.toFixed(4)}`
          : am.usage?.totalTokens
          ? `${am.usage.totalTokens.toLocaleString()} tokens`
          : null
        return (
          <div key={i} className="space-y-3">
            <div className="flex items-baseline gap-2">
              <div className="text-[10px] uppercase tracking-widest font-bold text-emerald-600/80">Pi</div>
              {am.model && <div className="text-[10px] text-muted-foreground/50 font-mono">{am.model}</div>}
              {meta && <div className="text-[10px] text-muted-foreground/40">{meta}</div>}
            </div>
            <div className="space-y-2 pl-3 border-l-2 border-emerald-500/20">{els}</div>
          </div>
        )
      }

      if (msg.role === 'toolResult') {
        // Tool results are inlined into the assistant tool call block above; skip standalone rendering.
        return null
      }

      if (msg.role === 'bashExecution') {
        const bm = msg as PiBashExecutionMessage
        return (
          <BashBlock
            key={i}
            command={bm.command}
            output={bm.output}
            exitCode={bm.exitCode}
            truncated={bm.truncated}
          />
        )
      }

      if (msg.role === 'compactionSummary') {
        const cm = msg as PiCompactionSummaryMessage
        return (
          <div key={i} className="my-1 px-3 py-2 rounded border border-dashed border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-600/70">
            <span className="font-semibold">Context compacted</span>
            {cm.tokensBefore && <span className="ml-1">({cm.tokensBefore.toLocaleString()} tokens)</span>}
            {cm.summary && <div className="mt-0.5 text-muted-foreground">{cm.summary}</div>}
          </div>
        )
      }

      if (msg.role === 'branchSummary') {
        const bsm = msg as PiBranchSummaryMessage
        return (
          <div key={i} className="my-1 px-3 py-2 rounded border border-dashed border-blue-500/20 bg-blue-500/5 text-[11px] text-blue-600/70">
            <span className="font-semibold">Branch summary</span>
            {bsm.summary && <div className="mt-0.5 text-muted-foreground">{bsm.summary}</div>}
          </div>
        )
      }

      return null
    },
  }
}

// ── Parser export ─────────────────────────────────────────────────────────────

export const piParser = {
  name: 'pi',

  canParse: (content: string): boolean => {
    const trimmed = content.trim()
    if (!trimmed) return false
    try {
      const first = JSON.parse(trimmed.split('\n')[0])
      return typeof first === 'object' && first !== null && first.type === 'session'
    } catch {
      return false
    }
  },

  parse: (content: string): TranscriptEntry[] =>
    content.trim().split('\n')
      .filter(l => l.trim())
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter((e): e is TranscriptEntry => e !== null),

  getRenderers: (entries: TranscriptEntry[]): RendererRegistry => {
    // Pre-index tool results so ToolCallBlock can render inline output.
    const toolResults: Record<string, { content: string; isError: boolean }> = {}
    for (const e of entries) {
      if (e.type !== 'message') continue
      const msg = (e as any).message as PiToolResultMessage | undefined
      if (!msg || msg.role !== 'toolResult') continue
      toolResults[msg.toolCallId] = {
        content: extractTextContent(msg.content),
        isError: msg.isError,
      }
    }
    return createPiRenderers(toolResults)
  },
}

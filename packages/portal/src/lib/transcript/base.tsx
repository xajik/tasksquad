import React from 'react'
import { Terminal, ChevronUp, ChevronDown, Code2, ExternalLink } from 'lucide-react'

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
  
  // Provider-specific metadata
  id?: string
  thoughts?: Array<{ subject: string; description: string; timestamp: string }>
  tokens?: { input: number; output: number; cached?: number; thoughts?: number; tool?: number; total: number }
  model?: string
  toolCalls?: Array<{
    id: string
    name: string
    args: any
    result?: any
    status?: string
    timestamp?: string
    displayName?: string
  }>
}

export type EntryRenderer = (entry: TranscriptEntry, index: number, rawContent?: string) => React.ReactNode | null
export type RendererRegistry = Record<string, EntryRenderer>

export interface TranscriptParser {
  name: string
  canParse: (content: string) => boolean
  parse: (content: string) => TranscriptEntry[]
  getRenderers: (entries: TranscriptEntry[]) => RendererRegistry
}

export function ToolExecution({ name, input, output, isError }: { name: string; input: unknown; output?: string; isError?: boolean }) {
  const [expanded, setExpanded] = React.useState(false)
  
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

import React, { useState } from 'react'
import { Brain, ChevronUp, ChevronDown } from 'lucide-react'
import { RendererRegistry, ToolExecution } from './base'

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

export const geminiParser = {
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
}

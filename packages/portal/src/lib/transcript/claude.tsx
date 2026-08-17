import React from 'react'
import { TranscriptEntry, RendererRegistry, ToolExecution } from './base'

// tool_result.content can be a plain string or an array of content blocks
// (e.g. [{type:'text', text:'...'}]) — never render it raw as a JSX child.
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string')
        ? (c as { text: string }).text
        : JSON.stringify(c))
      .join('\n')
  }
  return JSON.stringify(content, null, 2)
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
                  <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">{toolResultText(tr.content)}</pre>
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

export const claudeParser = {
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
  parse: (content: string) => {
    return content.trim().split('\n')
      .filter(l => l.trim())
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter((e): e is TranscriptEntry => e !== null)
  },
  getRenderers: createClaudeRenderers,
}

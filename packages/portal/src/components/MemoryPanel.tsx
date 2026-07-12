import { useState, useEffect, useMemo } from 'react'
import { api, type Memory, type MemoryCategory, type MemoryRollup } from '../lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, Database, Bot, X, Copy, Check, Link2, CalendarDays } from 'lucide-react'
import { relativeTime } from '../lib/utils'
import MarkdownRenderer from './MarkdownRenderer'

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  personal: 'Personal',
  preferences: 'Preferences',
  structure: 'Structure',
  architecture: 'Architecture',
  events: 'Events',
}

export function MemoryCard({
  memory,
  agents,
  onClick,
}: {
  memory: Memory
  agents: Map<string, string>
  onClick: () => void
}) {
  const agentLabel = memory.agent_id !== null
    ? (agents.get(memory.agent_id) ?? memory.agent_id.slice(0, 8))
    : null

  return (
    <Card className="cursor-pointer hover:border-primary/50 transition-all hover:shadow-sm group" onClick={onClick}>
      <CardHeader className="p-4 pb-2 flex-row items-start justify-between space-y-0">
        <CardTitle className="text-base font-medium line-clamp-2 group-hover:text-primary transition-colors pr-2">
          {memory.title}
        </CardTitle>
        <Badge variant="outline" className="shrink-0 text-xs">{MEMORY_CATEGORY_LABELS[memory.category]}</Badge>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        {memory.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {memory.tags.slice(0, 4).map(tag => (
              <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0 h-5">{tag}</Badge>
            ))}
            {memory.tags.length > 4 && <span className="text-[10px] text-muted-foreground">+{memory.tags.length - 4}</span>}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 mt-auto text-xs text-muted-foreground">
          <span>{relativeTime(memory.updated_at)}</span>
          {agentLabel && <span className="flex items-center gap-1"><Bot className="h-3 w-3" /> {agentLabel}</span>}
        </div>
      </CardContent>
    </Card>
  )
}

export function MemoryDetail({
  memory,
  teamId,
  agents,
  allMemory,
  onClose,
  onSelect,
}: {
  memory: Memory
  teamId: string
  agents: Map<string, string>
  /** The team's already-fetched memory list, used to cross-reference same-tag entries client-side. */
  allMemory: Memory[]
  onClose: () => void
  onSelect: (memory: Memory) => void
}) {
  const [fullMemory, setFullMemory] = useState<Memory | null>(null)
  const [copied, setCopied] = useState(false)

  const agentLabel = memory.agent_id !== null
    ? (agents.get(memory.agent_id) ?? memory.agent_id.slice(0, 8))
    : null

  useEffect(() => {
    setFullMemory(null)
    api.memory.get(teamId, memory.id).then(setFullMemory).catch(() => {})
  }, [teamId, memory.id])

  const linkedMemory = useMemo(
    () => allMemory.filter(m => m.id !== memory.id && m.tags.some(tag => memory.tags.includes(tag))),
    [allMemory, memory],
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-6 pb-4 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <Database className="h-5 w-5 text-muted-foreground shrink-0" />
          <h2 className="text-lg font-medium truncate">{memory.title}</h2>
          <Badge variant="outline" className="shrink-0 text-xs ml-1">{MEMORY_CATEGORY_LABELS[memory.category]}</Badge>
          {agentLabel && <Badge variant="secondary" className="shrink-0 text-xs gap-1 ml-1"><Bot className="h-3 w-3" /> {agentLabel}</Badge>}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <Button
            variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground"
            onClick={() => {
              const text = fullMemory?.content ?? ''
              if (text) {
                navigator.clipboard.writeText(text).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
              }
            }}
            title="Copy content"
            disabled={!fullMemory?.content}
          >
            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {memory.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {memory.tags.map(tag => <Badge key={tag} variant="secondary" className="text-[10px]">{tag}</Badge>)}
          </div>
        )}
        {fullMemory === null
          ? <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading content…</div>
          : <MarkdownRenderer content={fullMemory.content ?? '(empty)'} />
        }
        <div className="mt-4 text-xs text-muted-foreground">Last updated {relativeTime(memory.updated_at)}</div>

        {linkedMemory.length > 0 && (
          <div className="mt-8 pt-6 border-t">
            <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
              <Link2 className="h-3.5 w-3.5" /> Linked memory
            </h3>
            <div className="space-y-2">
              {linkedMemory.map(m => (
                <button
                  key={m.id}
                  onClick={() => onSelect(m)}
                  className="w-full text-left rounded-lg border bg-background hover:border-primary/50 hover:bg-muted/30 transition-colors p-2.5 group"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium line-clamp-1 group-hover:text-primary transition-colors">{m.title}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">{MEMORY_CATEGORY_LABELS[m.category]}</Badge>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 'YYYY-MM-DD' -> 'Today' / 'Yesterday' / 'Friday, July 10, 2026'. UTC-based since
 * period_key is computed in UTC (see packages/worker/src/cron/rollup.ts). */
function formatPeriodKey(periodKey: string): string {
  const now = new Date()
  const todayKey = now.toISOString().slice(0, 10)
  const yesterdayKey = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)
  if (periodKey === todayKey) return 'Today'
  if (periodKey === yesterdayKey) return 'Yesterday'
  return new Date(`${periodKey}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
}

export function DailyRollups({ rollups, loading }: { rollups: MemoryRollup[]; loading: boolean }) {
  if (loading) {
    return <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
  }

  if (rollups.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-12">
        <CalendarDays className="h-8 w-8 mx-auto mb-3 opacity-40" />
        <p className="text-sm">No daily snapshots yet.</p>
        <p className="text-xs mt-1 max-w-md mx-auto">
          A snapshot is compiled once a day has at least one global memory entry. Local-only
          memory never appears here, same as the category view.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4 max-w-3xl">
      {rollups.map(r => (
        <Card key={r.id}>
          <CardHeader className="p-4 pb-2 flex-row items-center gap-2 space-y-0">
            <CalendarDays className="h-4 w-4 text-muted-foreground shrink-0" />
            <CardTitle className="text-sm font-medium">{formatPeriodKey(r.period_key)}</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <MarkdownRenderer content={r.content} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Memory as MemoryEntry, type MemoryCategory, type MemoryRollup, type Team } from '../lib/api'
import { Button } from '@/components/ui/button'
import { Loader2, Database, RefreshCw } from 'lucide-react'
import { MemoryCard, MemoryDetail, DailyRollups, MEMORY_CATEGORY_LABELS } from '../components/MemoryPanel'

const CATEGORIES: MemoryCategory[] = ['personal', 'preferences', 'structure', 'architecture', 'events']

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
}

function EmptyState({ primary, secondary, action }: { primary: string; secondary: string; action?: React.ReactNode }) {
  return (
    <div className="text-center text-muted-foreground py-12">
      <Database className="h-8 w-8 mx-auto mb-3 opacity-40" />
      <p className="text-sm">{primary}</p>
      <p className="text-xs mt-1 max-w-md mx-auto">{secondary}</p>
      {action}
    </div>
  )
}

export function Memory({ teamId, currentTeam }: { teamId: string; currentTeam: Team | undefined }) {
  const nav = useNavigate()
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [rollups, setRollups] = useState<MemoryRollup[]>([])
  const [agents, setAgents] = useState<Map<string, string>>(new Map())
  const [tags, setTags] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<'category' | 'daily'>('category')
  const [category, setCategory] = useState<MemoryCategory | null>(null)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [selected, setSelected] = useState<MemoryEntry | null>(null)

  const memoryEnabled = currentTeam?.memory_enabled ?? true

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [memoryData, rollupsData, agentsData, tagsData] = await Promise.all([
        api.memory.list(teamId),
        api.memory.rollups(teamId).catch(() => ({ rollups: [] })),
        api.agents.list(teamId).catch(() => ({ agents: [] })),
        api.tags.list(teamId).catch(() => ({ tags: [] })),
      ])
      setEntries(memoryData.memory ?? [])
      setRollups(rollupsData.rollups ?? [])
      const map = new Map<string, string>()
      for (const a of agentsData.agents ?? []) map.set(a.id, a.name)
      setAgents(map)
      setTags((tagsData.tags ?? []).map(t => t.name))
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => { load() }, [load])

  function switchCategory(c: MemoryCategory | null) {
    setCategory(c)
    setSelected(null)
  }

  function switchView(v: 'category' | 'daily') {
    setView(v)
    setSelected(null)
  }

  const filtered = useMemo(() => entries.filter(m =>
    (category === null || m.category === category) &&
    (selectedTag === null || m.tags.includes(selectedTag))
  ), [entries, category, selectedTag])

  return (
    <div className="flex h-full">
      <div className={`flex flex-col ${selected ? 'w-1/2 border-r' : 'w-full'} overflow-hidden`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1.5">
            <h2 className="text-2xl font-semibold">Memory</h2>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={load} disabled={loading} title="Refresh">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {/* View tabs */}
        <div className="flex items-center gap-1 mb-3 p-1 bg-muted rounded-lg w-fit">
          <button
            onClick={() => switchView('category')}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${view === 'category' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            By Category
          </button>
          <button
            onClick={() => switchView('daily')}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${view === 'daily' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            Daily
            {rollups.length > 0 && (
              <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{rollups.length}</span>
            )}
          </button>
        </div>

        {view === 'category' && (
          <>
            {/* Category tabs */}
            <div className="flex items-center gap-1 mb-3 p-1 bg-muted rounded-lg w-fit flex-wrap">
              <button
                onClick={() => switchCategory(null)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${category === null ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                All
                <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{entries.length}</span>
              </button>
              {CATEGORIES.map(c => (
                <button
                  key={c}
                  onClick={() => switchCategory(c)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${category === c ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {MEMORY_CATEGORY_LABELS[c]}
                  <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                    {entries.filter(e => e.category === c).length}
                  </span>
                </button>
              ))}
            </div>

            {/* Tag filter */}
            {tags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mb-4 shrink-0">
                <Button variant={selectedTag === null ? 'secondary' : 'ghost'} size="sm" className="h-7 text-xs" onClick={() => setSelectedTag(null)}>
                  All tags
                </Button>
                {tags.map(tag => (
                  <Button
                    key={tag}
                    variant={selectedTag === tag ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                  >
                    {tag}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-6 pt-2">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : !memoryEnabled ? (
            <EmptyState
              primary="Memory is disabled for this project."
              secondary="Enable it in Settings to let agents automatically extract and share project knowledge across sessions."
              action={<Button variant="link" size="sm" onClick={() => nav('/dashboard/settings')}>Go to Settings</Button>}
            />
          ) : view === 'daily' ? (
            <DailyRollups rollups={rollups} loading={false} />
          ) : filtered.length === 0 ? (
            <EmptyState
              primary={entries.length === 0 ? 'No memory yet.' : 'No memory matches this filter.'}
              secondary={
                entries.length === 0
                  ? "It builds up as agents complete sessions. Local-only memory stays on each agent's machine by design and never appears here."
                  : 'Try a different category or tag.'
              }
            />
          ) : (
            <Grid>
              {filtered.map(m => (
                <MemoryCard key={m.id} memory={m} agents={agents} onClick={() => setSelected(m)} />
              ))}
            </Grid>
          )}
        </div>
      </div>

      {selected && (
        <div className="flex-1 overflow-hidden">
          <MemoryDetail
            key={selected.id}
            memory={selected}
            teamId={teamId}
            agents={agents}
            allMemory={entries}
            onClose={() => setSelected(null)}
            onSelect={setSelected}
          />
        </div>
      )}
    </div>
  )
}

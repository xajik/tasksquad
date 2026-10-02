import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, Loader2, RefreshCw, Table2 } from 'lucide-react'
import { api, type Agent, type NameCount, type TeamStats } from '../lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const DAY = 86_400_000
const RANGES = [
  { id: '24h', label: '24h', ms: DAY },
  { id: '7d', label: '7 days', ms: 7 * DAY },
  { id: '30d', label: '30 days', ms: 30 * DAY },
  { id: '90d', label: '90 days', ms: 90 * DAY },
] as const
type RangeId = typeof RANGES[number]['id']

// Status series: blue/red instead of green/red, which deuteranopes can't tell apart.
// Identity never rests on color alone: legend, tooltip and table view carry the labels.
// Validated (dataviz validate_palette.js): light 600 steps, dark 500 steps.
const DONE = { fill: 'fill-blue-600 dark:fill-blue-500', swatch: 'bg-blue-600 dark:bg-blue-500', label: 'Done' }
const FAILED = { fill: 'fill-red-600 dark:fill-red-500', swatch: 'bg-red-600 dark:bg-red-500', label: 'Failed' }

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const percent = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-background p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Stacked daily done/failed bars with a hover tooltip; a toggle swaps in a table. */
function DailyChart({ daily }: { daily: TeamStats['daily'] }) {
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const max = Math.max(1, ...daily.map(d => d.done + d.failed))
  const width = 720, height = 180, gap = daily.length > 45 ? 1 : 3
  const band = width / Math.max(daily.length, 1)
  const barWidth = Math.max(band - gap, 1)
  const y = (v: number) => (v / max) * (height - 8)
  const shortDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const active = hover === null ? null : daily[hover]

  return (
    <Section
      title="Completed tasks per day"
      action={
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setAsTable(v => !v)}>
          {asTable ? <BarChart3 className="mr-1 h-3.5 w-3.5" /> : <Table2 className="mr-1 h-3.5 w-3.5" />}
          {asTable ? 'Chart' : 'Table'}
        </Button>
      }
    >
      <div className="mb-2 flex items-center gap-4 text-xs text-muted-foreground">
        {[DONE, FAILED].map(s => (
          <span key={s.label} className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${s.swatch}`} />{s.label}</span>
        ))}
      </div>
      {asTable ? (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs text-muted-foreground"><tr><th className="py-1 text-left font-medium">Day</th><th className="text-right font-medium">Created</th><th className="text-right font-medium">Done</th><th className="text-right font-medium">Failed</th></tr></thead>
            <tbody>{daily.map(d => (
              <tr key={d.date} className="border-t"><td className="py-1">{shortDate(d.date)}</td><td className="text-right">{d.created}</td><td className="text-right">{d.done}</td><td className="text-right">{d.failed}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full" preserveAspectRatio="none" role="img"
               aria-label="Done and failed tasks per day" onMouseLeave={() => setHover(null)}>
            <line x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} className="stroke-border" />
            {daily.map((d, i) => {
              const x = i * band + gap / 2
              const done = y(d.done), failed = y(d.failed)
              return (
                <g key={d.date} onMouseEnter={() => setHover(i)}>
                  {/* Full-height hit target, larger than the marks. */}
                  <rect x={i * band} y={0} width={band} height={height} className={hover === i ? 'fill-muted' : 'fill-transparent'} />
                  {done > 0 && <rect x={x} y={height - done} width={barWidth} height={done} rx={failed > 0 ? 0 : Math.min(4, barWidth / 2)} className={DONE.fill} />}
                  {/* 2px surface gap between stacked segments. */}
                  {failed > 0 && <rect x={x} y={height - done - failed - (done > 0 ? 2 : 0)} width={barWidth} height={failed} rx={Math.min(4, barWidth / 2)} className={FAILED.fill} />}
                </g>
              )
            })}
          </svg>
          {active && hover !== null && (
            <div className="pointer-events-none absolute top-0 rounded-md border bg-background px-2.5 py-1.5 text-xs shadow-sm"
                 style={{ left: `min(calc(${((hover + 0.5) / daily.length) * 100}% + 8px), calc(100% - 9rem))` }}>
              <p className="font-medium">{shortDate(active.date)}</p>
              <p className="text-muted-foreground">{active.created} created</p>
              <p><span className={`mr-1.5 inline-block h-2 w-2 rounded-sm ${DONE.swatch}`} />{active.done} done</p>
              <p><span className={`mr-1.5 inline-block h-2 w-2 rounded-sm ${FAILED.swatch}`} />{active.failed} failed</p>
            </div>
          )}
          <div className="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>{daily[0] && shortDate(daily[0].date)}</span>
            <span>peak {max}/day</span>
            <span>{daily.length > 0 && shortDate(daily[daily.length - 1].date)}</span>
          </div>
        </div>
      )}
    </Section>
  )
}

/** Single-series ranked bars: one hue, values in text, no legend needed. */
function RankedBars({ title, items, empty }: { title: string; items: NameCount[]; empty: string }) {
  const max = Math.max(1, ...items.map(i => i.count))
  return (
    <Section title={title}>
      {items.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p> : (
        <ul className="space-y-2">
          {items.slice(0, 12).map(item => (
            <li key={item.name} className="text-sm">
              <div className="mb-0.5 flex justify-between gap-3">
                <span className="truncate font-mono text-xs" title={item.name}>{item.name}</span>
                <span className="tabular-nums text-muted-foreground">{compact.format(item.count)}</span>
              </div>
              <div className="h-1.5 rounded-full bg-muted">
                <div className="h-1.5 rounded-full bg-blue-600 dark:bg-blue-500" style={{ width: `${(item.count / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

export function Analytics({ teamId }: { teamId: string }) {
  const [range, setRange] = useState<RangeId>('30d')
  const [agentId, setAgentId] = useState<string>('all')
  const [agents, setAgents] = useState<Agent[]>([])
  const [stats, setStats] = useState<TeamStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    const to = Date.now(), from = to - RANGES.find(r => r.id === range)!.ms
    try {
      setStats(await api.stats.team(teamId, { from, to, agentId: agentId === 'all' ? undefined : agentId }))
    } catch (e: any) {
      setError(e?.error ?? 'Could not load statistics.')
    } finally { setLoading(false) }
  }, [teamId, range, agentId])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    api.agents.list(teamId).then(r => setAgents(r.agents ?? [])).catch(() => setAgents([]))
    setAgentId('all')
  }, [teamId])

  const tokens = useMemo(() => stats ? stats.usage.input_tokens + stats.usage.output_tokens : 0, [stats])
  const t = stats?.totals

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-2xl font-semibold">Analytics</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={load} disabled={loading} title="Refresh">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        {/* Filters: one row above the charts. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
            {RANGES.map(r => (
              <button key={r.id} onClick={() => setRange(r.id)}
                className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${range === r.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                {r.label}
              </button>
            ))}
          </div>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger className="h-8 w-44 text-sm"><SelectValue placeholder="All agents" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              {agents.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</p>}
      {!stats && loading && <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}

      {stats && t && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Tile label="Tasks created" value={compact.format(t.created)} hint={`${t.started} started`} />
            <Tile label="Done" value={compact.format(t.done)} />
            <Tile label="Failed" value={compact.format(t.failed)} hint={t.cancelled ? `${t.cancelled} cancelled` : undefined} />
            <Tile label="Success rate" value={percent(t.success_rate)} hint="done ÷ (done + failed)" />
            <Tile label="Median time to done" value={formatDuration(t.median_completion_ms)} />
            <Tile label="In progress" value={compact.format(t.in_progress)} hint={t.scheduled ? `${t.scheduled} scheduled` : undefined} />
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Tool calls" value={compact.format(stats.usage.tool_calls)} hint={stats.usage.tool_errors ? `${stats.usage.tool_errors} errors` : undefined} />
            <Tile label="Tokens" value={compact.format(tokens)} hint={`${compact.format(stats.usage.input_tokens)} in · ${compact.format(stats.usage.output_tokens)} out`} />
            <Tile label="Agent active time" value={formatDuration(stats.usage.active_ms)} hint={`${stats.usage.sessions_reported} sessions reported`} />
            <Tile label="Feedback" value={`${t.grades_up} 👍 · ${t.grades_down} 👎`} />
          </div>
          {stats.usage.sessions_reported === 0 && (
            <p className="text-xs text-muted-foreground">Tool, skill and token usage appears once agents run on a daemon version that sends session reports.</p>
          )}

          <DailyChart daily={stats.daily} />

          <div className="grid gap-3 md:grid-cols-2">
            <RankedBars title="Most used tools" items={stats.tools} empty="No tool usage reported in this range." />
            <RankedBars title="Skills used" items={stats.skills} empty="No skills invoked in this range." />
          </div>

          <Section title="Agent performance">
            {stats.agents.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No tasks in this range.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm tabular-nums">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="text-right">
                      <th className="py-1.5 text-left font-medium">Agent</th><th className="font-medium">Tasks</th><th className="font-medium">Done</th>
                      <th className="font-medium">Failed</th><th className="font-medium">Success</th><th className="font-medium">Median time</th>
                      <th className="font-medium">👍 / 👎</th><th className="font-medium">Tool calls</th><th className="font-medium">Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.agents.map(a => (
                      <tr key={a.agent_id} className="border-t text-right">
                        <td className="py-2 text-left font-medium">{a.name}</td>
                        <td>{a.tasks}</td><td>{a.done}</td><td>{a.failed}</td><td>{percent(a.success_rate)}</td>
                        <td>{formatDuration(a.median_completion_ms)}</td><td>{a.grades_up} / {a.grades_down}</td>
                        <td>{compact.format(a.tool_calls)}</td><td>{compact.format(a.input_tokens + a.output_tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  )
}

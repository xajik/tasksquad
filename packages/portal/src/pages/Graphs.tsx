import { Copy, Play, Pause, RefreshCw } from 'lucide-react'
import { parseJson } from '@/lib/parseJson'
import { goalVerificationLabel, needsOwner } from '@/lib/graphStatus'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, type Agent } from '../lib/api'
import {
  defaultGraphPolicy,
  graphApi,
  graphRunExplanation,
  type GraphSnapshot,
  type GraphSummary,
  type GraphPolicy,
  type GraphSearchHit,
  type GraphResource,
} from '../lib/graph'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { GraphCanvas } from '@/components/GraphCanvas'
import { CreateGraphDialog, CloneDialog, SettingsDialog, ResourceDialog } from '@/components/GraphDialogs'
import { GraphWorkSection, type Confirming } from '@/components/GraphWorkSection'
import { GraphInspector } from '@/components/GraphInspector'
import { GraphSection } from '@/components/GraphSection'
import { dailyReport, latestMessage } from '@/lib/graphReport'
import { isGuidance } from '@/lib/graphLayout'
import { goalProjection } from '@/lib/graphProjection'
import { graphAttention } from '@/lib/graphAttention'
import { errorText } from '@/lib/graphError'
import {
  GraphDashboardPanels,
  GraphMetrics,
  GoalState,
  graphViewIcons
} from '@/components/GraphDashboardPanels'
import { graphViews, graphView, type GraphView } from '@/lib/graphDashboard'

import { plural, proposalState, stamp } from '@/lib/graphWork'


export function Graphs({
  teamId,
  isMaintainer,
  plan
}: {
  teamId: string
  isMaintainer: boolean
  plan: 'free' | 'pro'
}) {
  const { graphId } = useParams<{ graphId?: string }>(),
    nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const view = graphView(params.get('view'))
  const setView = (next: GraphView) =>
    setParams((previous) => {
      const updated = new URLSearchParams(previous)
      if (next === 'home') updated.delete('view')
      else updated.set('view', next)
      return updated
    })
  const [live, setLive] = useState(true)
  const [updatedAt, setUpdatedAt] = useState(0)
  const [nodeLimit, setNodeLimit] = useState(20)
  const [range, setRange] = useState(86400_000)
  const now = updatedAt || Date.now()
  const inspect = (id: string) => {
    setSelected(id)
    setView('home')
  }
  const [graphs, setGraphs] = useState<GraphSummary[]>([]),
    [agents, setAgents] = useState<Agent[]>([]),
    [current, setCurrent] = useState<GraphSnapshot | null>(null)
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [create, setCreate] = useState(false),
    [settings, setSettings] = useState(false)
  const [policy, setPolicy] = useState<GraphPolicy>(defaultGraphPolicy),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState<string | null>(null),
    [resourceOpen, setResourceOpen] = useState(false)
  const [cloneSource, setCloneSource] = useState<GraphSummary | null>(null),
    [cloneError, setCloneError] = useState('')
  const [matches, setMatches] = useState<{
    nodes: GraphSearchHit[]
    resources: GraphResource[]
    edges: GraphSearchHit[]
  } | null>(null)
  const generation = useRef(0),
    searchRef = useRef<HTMLInputElement>(null)
  const lastDetail = useRef('')
  // `full` also reloads the graph list and agents; routine polls only need the snapshot.
  const refresh = useCallback(async (full = true) => {
    const version = ++generation.current
    try {
      const [list, ad, detail] = await Promise.all([
        full ? graphApi.list(teamId) : null,
        full ? api.agents.list(teamId) : null,
        graphId ? graphApi.get(teamId, graphId) : Promise.resolve(null)
      ])
      if (version !== generation.current) return
      if (list) setGraphs(list.graphs)
      if (ad) setAgents(ad.agents)
      // Keep the same object when nothing changed so memoized derivations and children skip work.
      const serialized = JSON.stringify(detail)
      if (serialized !== lastDetail.current) {
        lastDetail.current = serialized
        setCurrent(detail)
      }
      setUpdatedAt(Date.now())
      setError('')
    } catch (e) {
      if (version === generation.current) setError(errorText(e))
    } finally {
      if (version === generation.current) setLoading(false)
    }
  }, [teamId, graphId])
  useEffect(() => {
    lastDetail.current = ''
    setCurrent(null)
    setLoading(true)
    setSelected(null)
    setNodeLimit(20)
    setCloneSource(null)
    setCloneError('')
  }, [teamId, graphId])
  useEffect(() => {
    void refresh()
    let ticks = 0
    const timer = live
      ? setInterval(
          () => {
            // Skip background tabs; reload the list and agents only occasionally.
            if (document.hidden) return
            void refresh(++ticks % 10 === 0)
          },
          plan === 'pro' ? 2000 : 5000
        )
      : undefined
    return () => {
      clearInterval(timer)
      generation.current++
    }
  }, [refresh, plan, live])
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setParams((previous) => {
          const next = new URLSearchParams(previous)
          next.delete('view')
          return next
        })
        setTimeout(() => searchRef.current?.focus(), 0)
      }
      if (e.key === 'Escape') {
        setSearch('')
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [setParams])
  useEffect(() => {
    let active = true
    if (!graphId || !search.trim()) {
      setMatches(null)
      return
    }
    const timer = setTimeout(() => {
      graphApi
        .search(teamId, graphId, search)
        .then((result) => {
          if (active) setMatches(result)
        })
        .catch(() => {
          if (active) setMatches(null)
        })
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [teamId, graphId, search])
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  async function command(action: string, data: unknown = {}) {
    if (!graphId) return false
    setBusy(true)
    setError('')
    try {
      await graphApi.command(teamId, graphId, action, data)
      await refresh()
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  async function cloneGraph(withNodes: boolean) {
    if (!cloneSource || busy) return
    setBusy(true)
    setError('')
    setCloneError('')
    try {
      const g = await graphApi.clone(teamId, cloneSource.id, withNodes)
      setCloneSource(null)
      nav(`/dashboard/graphs/${g.id}`)
    } catch (e) {
      setCloneError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const node = current?.nodes.find((n) => n.id === selected),
    edge = current?.edges.find((e) => e.id === selected)
  const attention = useMemo(() => (current ? graphAttention(current) : null), [current])
  const nodeAttention = node
    ? (attention?.nodes.get(node.id) ?? [])
    : edge
      ? (attention?.edges.get(edge.id) ?? [])
      : []
  const projection = useMemo(
    () => (current && node && !isGuidance(node) ? goalProjection(current, node.id) : null),
    [current, node]
  )
  const reviews = current?.results.filter((r) => r.status === 'review') ?? [],
    blocked =
      current?.assignments.filter(
        (a) => a.role !== 'repair' && ['blocked', 'error', 'reconciling'].includes(a.status)
      ) ?? []
  const active = current?.attempts.filter((a) => a.status === 'running' || a.status === 'pending') ?? []
  if (loading) return <p role="status">Loading graphs…</p>
  return (
    <div className="space-y-5 pb-8">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-semibold">Graph</h2>
          {current && (
            <select
              aria-label="Select graph"
              className="max-w-64 rounded border bg-background p-2 text-sm"
              value={graphId}
              onChange={(e) => nav(`/dashboard/graphs/${e.target.value}`)}
            >
              {graphs.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex gap-2">
          {!current && isMaintainer && <Button onClick={() => setCreate(true)}>New graph</Button>}
          {current && (
            <>
              {isMaintainer && current.status !== 'stopped' && (
                <Button
                  variant={current.status === 'running' ? 'outline' : 'default'}
                  disabled={busy}
                  onClick={() => command(current.status === 'running' ? 'pause' : 'run')}
                >
                  {current.status === 'running' ? (
                    <Pause className="mr-1 h-4 w-4" />
                  ) : (
                    <Play className="mr-1 h-4 w-4" />
                  )}
                  {current.status === 'running' ? 'Pause' : 'Run'}
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setPolicy(current.config.policy)
                  setSettings(true)
                }}
              >
                Settings
              </Button>
            </>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">
          {error.includes('not_found') ? 'Graph is not enabled for this workspace.' : error}
        </p>
      )}
      {!graphId && (
        <div className="divide-y rounded-lg border">
          {graphs.length
            ? graphs.map((g) => (
                <div key={g.id} className="flex items-center gap-3 px-4 hover:bg-muted">
                  <Link className="min-w-0 flex-1 py-4" to={`/dashboard/graphs/${g.id}`}>
                    <b>{g.title}</b>
                    <span className="block text-sm text-muted-foreground">{g.description}</span>
                  </Link>
                  <Badge variant="outline">{g.status === 'stopped' ? 'Closed' : g.status}</Badge>
                  {isMaintainer && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || g.status !== 'stopped'}
                      aria-label={`Clone ${g.title}`}
                      title={g.status === 'stopped' ? 'Clone this graph' : 'Close this graph before cloning'}
                      onClick={() => {
                        setCloneError('')
                        setCloneSource(g)
                      }}
                    >
                      <Copy className="mr-1 h-4 w-4" />
                      Clone
                    </Button>
                  )}
                </div>
              ))
            : !error && (
                <p className="p-6 text-muted-foreground">
                  Create a graph to connect observed context with a measurable goal.
                </p>
              )}
        </div>
      )}
      {current && (
        <>
          <section className="flex justify-between gap-4 flex-wrap border-b pb-4">
            <div>
              <h3 className="font-semibold">{current.title}</h3>
              <GraphSection
                id="goal"
                title="Goal description"
                help="section_goal"
                defaultOpen={false}
                className="text-sm"
              >
                <p className="text-muted-foreground whitespace-pre-wrap">{current.body}</p>
              </GraphSection>
              <p className="mt-2 text-sm">
                Goal:{' '}
                <b>
                  {goalVerificationLabel(current.goal_verification)}
                </b>{' '}
                · {current.status} ·{' '}
                {plural(current.nodes.filter((n) => !isGuidance(n)).length, 'execution state')} ·{' '}
                {plural(current.edges.length, 'action')} ·{' '}
                {plural(current.nodes.filter(isGuidance).length, 'guidance item')}
              </p>
            </div>
            {current.status === 'stopped' && (
              <span className="rounded border px-2 py-1 text-sm text-muted-foreground">Closed</span>
            )}
          </section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span
                className={`h-2 w-2 rounded-full ${live && !error ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
              />
              {live ? `Live · refresh every ${plan === 'pro' ? 2 : 5}s` : 'Refresh paused'}
              <span className="text-xs">
                Updated {updatedAt ? new Date(updatedAt).toLocaleTimeString() : '—'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <select
                aria-label="Statistics and activity time range"
                  title="Applies to Statistics and Activity. Other tabs show current state."
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={range}
                onChange={(e) => setRange(Number(e.target.value))}
              >
                <option value={3600000}>Last 1 hour</option>
                <option value={21600000}>Last 6 hours</option>
                <option value={86400000}>Last 24 hours</option>
                <option value={0}>All time</option>
              </select>
              <Button variant="outline" size="sm" onClick={() => setLive(!live)}>
                {live ? 'Pause refresh' : 'Resume refresh'}
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label="Refresh graph dashboard"
                onClick={() => void refresh()}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <GraphMetrics graph={current} />
          <nav role="tablist" aria-label="Graph dashboard" className="sticky top-0 z-10 flex gap-1 overflow-x-auto border-b bg-background">
            {graphViews.map(([id, label], index) => {
              const Icon = graphViewIcons[id]
              const count =
                id === 'inbox'
                  ? Object.values(current.waiting ?? {}).filter((w) =>
                      needsOwner(w.action)
                    ).length
                  : id === 'deactivated'
                    ? current.nodes.filter((n) => n.state === 'deactivated').length
                    : null
              return (
                <button
                  key={id}
                  id={`graph-tab-${id}`}
                  type="button"
                  role="tab"
                  aria-selected={view === id}
                  aria-controls={`graph-panel-${id}`}
                  tabIndex={view === id ? 0 : -1}
                  className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-3 text-sm font-medium transition-colors ${view === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setView(id)}
                  onKeyDown={(e) => {
                    const target =
                      e.key === 'ArrowRight'
                        ? (index + 1) % graphViews.length
                        : e.key === 'ArrowLeft'
                          ? (index + graphViews.length - 1) % graphViews.length
                          : e.key === 'Home'
                            ? 0
                            : e.key === 'End'
                              ? graphViews.length - 1
                              : null
                    if (target !== null) {
                      e.preventDefault()
                      setView(graphViews[target][0])
                      document.getElementById(`graph-tab-${graphViews[target][0]}`)?.focus()
                    }
                  }}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                  {count !== null && count > 0 && (
                    <span className="rounded bg-muted px-1.5 text-xs tabular-nums">{count}</span>
                  )}
                </button>
              )
            })}
          </nav>
          <div
            id={`graph-panel-${view}`}
            role="tabpanel"
            aria-labelledby={`graph-tab-${view}`}
            className="space-y-4 min-w-0"
          >
            <GraphDashboardPanels
              key={`${current.id}-${view}`}
              view={view}
              graph={current}
              inspect={inspect}
              since={range ? now - range : 0}
              now={now}
            />
            {view === 'goals' && <GoalState graph={current} inspect={inspect} now={now} />}
            {view === 'home' &&
              (() => {
                const latest = latestMessage(current)
                if (!latest) return null
                return (
                  <GraphSection
                    id="latest"
                    title="Latest message"
                    help="section_latest"
                    className="rounded border bg-muted/30 px-3 py-2 text-sm"
                  >
                    <p>
                      <b>{latest.role}</b> · {latest.status} · {stamp(latest.at)}
                    </p>
                    <p className="text-muted-foreground">{latest.text}</p>
                    {latest.taskId && (
                      <Link className="text-primary underline" to={`/dashboard/tasks/${latest.taskId}`}>
                        Open inbox task
                      </Link>
                    )}
                  </GraphSection>
                )
              })()}
            {(view === 'home' || view === 'inbox') && (
              <p role="status" className="rounded border bg-muted/30 px-3 py-2 text-sm">
                {graphRunExplanation(current)}
              </p>
            )}
            {view === 'home' && active.length > 0 && (
              <section aria-label="Running jobs" className="flex flex-wrap gap-3 text-sm">
                {active.map((t) => (
                  <Link key={t.id} className="text-primary underline" to={`/dashboard/tasks/${t.task_id}`}>
                    {agents.find((a) => a.id === t.agent_id)?.name ?? t.agent_id}:{' '}
                    {current.assignments.find((a) => a.id === t.assignment_id)?.role} · {t.status}
                  </Link>
                ))}
              </section>
            )}
            {view === 'home' && (reviews.length > 0 || blocked.length > 0) && (
              <p className="text-sm rounded border-l-4 border-amber-500 bg-amber-500/10 px-3 py-2">
                Replies and result reviews are handled in{' '}
                <Link className="underline font-medium" to="/dashboard">
                  Inbox
                </Link>
                . Select a highlighted node to open its task.
              </p>
            )}
            {view === 'home' && (
              <Input
                ref={searchRef}
                aria-label="Search graph"
                placeholder="Search nodes, edges and resources…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            )}
            {view === 'home' && matches && (
              <section aria-label="Search results" className="flex flex-wrap gap-2">
                {matches.nodes.map((n) => (
                  <Button size="sm" variant="outline" key={n.id} onClick={() => setSelected(n.id)}>
                    {n.title}
                  </Button>
                ))}
                {(matches.edges ?? []).map((e) => (
                  <Button size="sm" variant="outline" key={e.id} onClick={() => setSelected(e.id)}>
                    {e.title}
                  </Button>
                ))}
                {matches.resources.map((r) => (
                  <details key={r.id} className="rounded border px-3 py-1 text-sm">
                    <summary className="cursor-pointer">{r.title}</summary>
                    <p className="whitespace-pre-wrap">{r.body}</p>
                  </details>
                ))}
              </section>
            )}
            {view === 'inbox' &&
              (current.proposals ?? []).some((p) => p.status === 'pending' || p.status === 'uncertain') && (
                <GraphSection
                  id="proposals"
                  title="Proposals awaiting independent review"
                  help="section_proposals"
                  className="rounded border p-4"
                >
                  <ul className="divide-y">
                    {(current.proposals ?? [])
                      .filter((p) => p.status === 'pending' || p.status === 'uncertain')
                      .map((p) => {
                        const proposal = parseJson<{ title?: string; description?: string; kind?: string }>(
                          p.content,
                          {}
                        )
                        return (
                          <li key={p.id} className="py-2 text-sm">
                            <b>{proposal.title ?? proposal.kind ?? 'Proposal'}</b> ·{' '}
                            {proposalState(current, p.id, p.status)}
                            <p className="text-muted-foreground">{proposal.description}</p>
                          </li>
                        )
                      })}
                  </ul>
                </GraphSection>
              )}
            {view === 'home' && (
              <GraphSection id="canvas" title="Action graph and inspector" help="section_canvas">
                <section className="grid xl:grid-cols-[minmax(0,1fr)_300px] rounded-lg border overflow-hidden">
                  <GraphCanvas
                    graph={current}
                    selected={selected}
                    onSelect={setSelected}
                    search={search}
                    matchedIds={matches?.nodes.map((n) => n.id)}
                  />
                  <GraphInspector
                    current={current}
                    node={node}
                    edge={edge}
                    nodeAttention={nodeAttention}
                    projection={projection}
                    isMaintainer={isMaintainer}
                    busy={busy}
                    search={search}
                    command={command}
                    onAddResource={() => setResourceOpen(true)}
                  />
                </section>
              </GraphSection>
            )}
            {view === 'statistics' &&
              (() => {
                const report = dailyReport(current)
                return (
                  <GraphSection
                    id="report"
                    title="Daily report"
                    help="section_report"
                    className="rounded border p-4 text-sm"
                  >
                    <p className="font-medium">{report.headline}</p>
                    <ul className="mt-1 list-disc pl-5 space-y-0.5 text-muted-foreground">
                      {report.lines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-muted-foreground">Details</summary>
                      <div className="space-y-4 pt-2">
                        <p className="text-sm">
                          Today ({new Date().toISOString().slice(0, 10)}, UTC) · goal{' '}
                          {current.goal_verification}
                        </p>
                        <h4 className="font-medium">Completed attempts</h4>
                        {current.attempts
                          .filter(
                            (t) =>
                              t.completed_at &&
                              new Date(t.completed_at).toISOString().slice(0, 10) ===
                                new Date().toISOString().slice(0, 10)
                          )
                          .map((t) => {
                            const a = current.assignments.find((a) => a.id === t.assignment_id),
                              r = current.results.find((r) => r.attempt_id === t.id)
                            return (
                              <p className="text-sm" key={t.id}>
                                <Link className="text-primary underline" to={`/dashboard/tasks/${t.task_id}`}>
                                  {a?.role} · {t.status}
                                </Link>{' '}
                                · completed {stamp(t.completed_at)} · {r?.status ?? 'grade pending'} ·
                                accepted {stamp(r?.accepted_at ?? null)}
                                {isMaintainer && a?.role === 'execute' && r?.status === 'accepted' && (
                                  <Button
                                    className="ml-2"
                                    size="sm"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() => command('regrade', { execution_result_id: r.id })}
                                  >
                                    Request regrade
                                  </Button>
                                )}
                              </p>
                            )
                          })}
                        <h4 className="font-medium">Every node</h4>
                        {current.nodes.slice(0, nodeLimit).map((n) => (
                          <p className="text-sm" key={n.id}>
                            {n.title} · {n.state} ·{' '}
                            {new Date(Math.max(n.created_at, n.state_changed_at ?? 0))
                              .toISOString()
                              .slice(0, 10) === new Date().toISOString().slice(0, 10) ||
                            current.events.some(
                              (e) =>
                                e.entity_id === n.id &&
                                new Date(e.created_at).toISOString().slice(0, 10) ===
                                  new Date().toISOString().slice(0, 10)
                            )
                              ? 'updated today'
                              : 'unchanged today'}
                          </p>
                        ))}
                        {current.nodes.length > nodeLimit && (
                          <Button size="sm" variant="outline" onClick={() => setNodeLimit(nodeLimit + 20)}>
                            Show more ({current.nodes.length - nodeLimit} left)
                          </Button>
                        )}
                      </div>
                    </details>
                  </GraphSection>
                )
              })()}
            <AlertDialog open={!!confirming} onOpenChange={(open) => !open && setConfirming(null)}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{confirming?.title}</AlertDialogTitle>
                  <AlertDialogDescription>{confirming?.description}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => void confirming?.run()}
                  >
                    {confirming?.confirm}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            {(view === 'inbox' || view === 'activity') && (
              <GraphWorkSection
                current={current}
                view={view}
                isMaintainer={isMaintainer}
                busy={busy}
                blocked={blocked}
                now={now}
                range={range}
                command={command}
                setConfirming={setConfirming}
              />
            )}
          </div>
        </>
      )}
      <CreateGraphDialog
        open={create}
        onOpenChange={setCreate}
        teamId={teamId}
        agents={agents}
        onCreated={(g) => nav(`/dashboard/graphs/${g.id}`)}
      />
      <CloneDialog
        source={cloneSource}
        busy={busy}
        error={cloneError}
        onClose={() => setCloneSource(null)}
        onClone={cloneGraph}
      />
      <SettingsDialog
        key={graphId}
        open={settings}
        onOpenChange={setSettings}
        current={current}
        isMaintainer={isMaintainer}
        busy={busy}
        policy={policy}
        setPolicy={setPolicy}
        agents={agents}
        command={command}
      />
      <ResourceDialog open={resourceOpen} onOpenChange={setResourceOpen} busy={busy} command={command} />
    </div>
  )
}

import { Copy, Play, Pause, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, type Agent } from '../lib/api'
import {
  defaultGraphPolicy,
  graphApi,
  latestGraphAttempt,
  graphRunExplanation,
  type GraphSnapshot,
  type GraphSummary,
  type NewGraph,
  type GraphPolicy,
  type GraphSearchHit,
  type GraphResource,
  type GraphAssignment
} from '../lib/graph'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
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
import { GraphSection } from '@/components/GraphSection'
import { dailyReport, latestMessage } from '@/lib/graphReport'
import { FieldHelp, LabelText } from '@/components/FieldHelp'
import type { GraphHelpKey } from '@/lib/graphHelp'
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

/** What the person must look at first: their decisions, then recovery, running work, then queued work by priority. */
const workRank = (status: string) =>
  ['review', 'blocked', 'error'].includes(status)
    ? 0
    : ['reconciling', 'restoring'].includes(status)
      ? 1
      : status === 'running' || status === 'continuation'
        ? 2
        : status === 'pending'
          ? 3
          : 4
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
/** Where a pending proposal really stands: its independent merge review may be queued, running, held for you or blocked. */
function proposalState(graph: GraphSnapshot, proposalId: string, status: string): string {
  const merge = graph.assignments.find((a) => {
    if (a.role !== 'merge') return false
    try {
      return (JSON.parse(a.input) as { proposal_id?: string }).proposal_id === proposalId
    } catch {
      return false
    }
  })
  switch (merge?.status) {
    case 'pending':
      return 'merge review queued'
    case 'running':
      return 'merge review running'
    case 'review':
      return 'merge review waiting for your decision in the inbox'
    case 'blocked':
    case 'error':
      return 'merge review blocked or rejected — reply in the inbox to continue'
    default:
      return status
  }
}
const pretty = (value: string) => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}
const stamp = (time: number | null) => (time ? new Date(time).toLocaleString() : 'Pending')

function PolicyFields({
  value,
  onChange,
  agents
}: {
  value: GraphPolicy
  onChange: (p: GraphPolicy) => void
  agents: Agent[]
}) {
  const field = (key: keyof GraphPolicy, next: unknown) => onChange({ ...value, [key]: next })
  const agentSelect = (key: 'grader' | 'decomposer' | 'fallback', label: string) => (
    <Label className="grid min-w-0 gap-2">
      <LabelText field={key}>{label}</LabelText>
      <select
        className="h-9 w-full min-w-0 rounded-md border bg-background px-2"
        value={value[key] ?? ''}
        onChange={(e) => field(key, e.target.value || null)}
        required={key !== 'fallback'}
      >
        <option value="">{key === 'fallback' ? 'None' : 'Select agent'}</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </Label>
  )
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="inline-flex items-center text-sm font-medium">
          Execution agents
          <FieldHelp field="agents" />
        </legend>
        {agents.map((a) => (
          <Label key={a.id} className="inline-flex items-center gap-2 mr-4">
            <input
              type="checkbox"
              checked={value.agents.includes(a.id)}
              onChange={(e) =>
                field(
                  'agents',
                  e.target.checked ? [...value.agents, a.id] : value.agents.filter((id) => id !== a.id)
                )
              }
            />
            {a.name}
          </Label>
        ))}
      </fieldset>
      <div className="grid sm:grid-cols-3 gap-4">
        {agentSelect('decomposer', 'Decomposition agent')}
        {agentSelect('grader', 'Grading agent')}
        {agentSelect('fallback', 'Fallback agent')}
      </div>
      <p className="text-xs text-muted-foreground">
        Execution needs an agent separate from the grader. Existing local agents remain trusted with machine
        access.
      </p>
      <div className="grid sm:grid-cols-2 gap-4">
        <Label className="grid min-w-0 gap-2">
          <LabelText field="capacity">Execution slots</LabelText>
          <Input
            type="number"
            min={1}
            max={32}
            value={value.capacity}
            onChange={(e) => field('capacity', Number(e.target.value))}
          />
        </Label>
        <Label className="grid min-w-0 gap-2">
          <LabelText field="threshold">Necessity threshold</LabelText>
          <Input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={value.threshold}
            onChange={(e) => field('threshold', Number(e.target.value))}
          />
        </Label>
        <Label className="grid min-w-0 gap-2 sm:col-span-2">
          <LabelText field="review">Result acceptance</LabelText>
          <select
            className="h-9 w-full min-w-0 rounded-md border bg-background px-2"
            value={value.review ? 'review' : 'auto'}
            onChange={(e) => field('review', e.target.value === 'review')}
          >
            <option value="review">Require review for every role</option>
            <option value="auto">Accept valid results automatically</option>
          </select>
        </Label>
      </div>
      <details>
        <summary className="cursor-pointer text-sm">Budgets, retries and maintenance</summary>
        <div className="grid sm:grid-cols-3 gap-4 pt-4">
          {(
            [
              ['max_attempts', 'Attempts per assignment', 1, 1],
              ['attempt_budget', 'Total attempt budget', 1, 1],
              ['planning_budget', 'Planning attempt budget', 1, 1],
              ['cost_budget', 'Declared execution cost limit', 0, 0.1],
              ['recovery_budget', 'Reserved recovery cost limit', 0, 0.1],
              ['deadline_ms', 'Job deadline (minutes)', 1, 1, 60_000],
              ['ttl_ms', 'Candidate TTL (hours)', 1, 1, 3600_000],
              ['maintenance_ms', 'Maintenance interval (minutes)', 1, 1, 60_000],
              ['freshness_ms', 'Evidence freshness (hours)', 1, 1, 3600_000]
            ] as const
          ).map(([key, label, min, step, unit = 1]) => (
            <Label key={key} className="grid min-w-0 gap-2">
              <LabelText field={key as GraphHelpKey}>{label}</LabelText>
              <Input
                type="number"
                min={min}
                step={step}
                value={value[key] / unit}
                onChange={(e) => field(key, Number(e.target.value) * unit)}
              />
            </Label>
          ))}
        </div>
      </details>
    </>
  )
}

function CreateGraph({
  teamId,
  agents,
  onCreated
}: {
  teamId: string
  agents: Agent[]
  onCreated: (g: GraphSummary) => void
}) {
  const [form, setForm] = useState<NewGraph>({
    title: '',
    description: '',
    body: '',
    start_state: '',
    policy: { ...defaultGraphPolicy },
    rule: { op: 'AND', predicates: [], scope: '' }
  })
  const [predicates, setPredicates] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onCreated(
        await graphApi.create(teamId, {
          ...form,
          rule: {
            ...form.rule,
            predicates: predicates
              .split('\n')
              .map((p) => p.trim())
              .filter(Boolean)
          }
        })
      )
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      {(['title', 'description', 'body', 'start_state'] as const).map((key) => (
        <Label className="grid gap-2" key={key}>
          <LabelText field={key}>
            {
              {
                title: 'Graph name',
                description: 'Short description',
                body: 'Goal and success definition',
                start_state: 'Observed start state'
              }[key]
            }
          </LabelText>
          {key === 'title' || key === 'description' ? (
            <Input
              required={key === 'title'}
              maxLength={key === 'title' ? 299 : 299}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          ) : (
            <Textarea
              required
              maxLength={3999}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          )}
        </Label>
      ))}
      <Label className="grid gap-2">
        <LabelText field="predicates">Success predicates (one per line)</LabelText>
        <Textarea
          required
          value={predicates}
          onChange={(e) => setPredicates(e.target.value)}
          placeholder="Measured result meets the target over the declared window"
        />
      </Label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Label className="grid min-w-0 gap-2">
          <LabelText field="rule">Sufficient rule</LabelText>
          <select
            className="h-9 w-full min-w-0 rounded-md border bg-background px-2"
            value={form.rule.op}
            onChange={(e) => setForm({ ...form, rule: { ...form.rule, op: e.target.value as 'AND' | 'OR' } })}
          >
            <option>AND</option>
            <option>OR</option>
          </select>
        </Label>
        <Label className="grid min-w-0 gap-2">
          <LabelText field="scope">Evidence scope</LabelText>
          <Input
            required
            maxLength={299}
            value={form.rule.scope}
            onChange={(e) => setForm({ ...form, rule: { ...form.rule, scope: e.target.value } })}
            placeholder="Production · declared cohort/window"
          />
        </Label>
      </div>
      <PolicyFields value={form.policy} onChange={(policy) => setForm({ ...form, policy })} agents={agents} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy || !agents.length}>{busy ? 'Creating…' : 'Create draft graph'}</Button>
    </form>
  )
}

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
  const tab = view === 'activity' ? 'activity' : 'next'
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
    [settings, setSettings] = useState(false),
    [closeConfirm, setCloseConfirm] = useState(false),
    [closeError, setCloseError] = useState('')
  const [policy, setPolicy] = useState<GraphPolicy>(defaultGraphPolicy),
    [search, setSearch] = useState(''),
    [selected, setSelected] = useState<string | null>(null)
  const [input, setInput] = useState<Record<string, string>>({}),
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
  const refresh = useCallback(async () => {
    const version = ++generation.current
    try {
      const [list, ad, detail] = await Promise.all([
        graphApi.list(teamId),
        api.agents.list(teamId),
        graphId ? graphApi.get(teamId, graphId) : Promise.resolve(null)
      ])
      if (version !== generation.current) return
      setGraphs(list.graphs)
      setAgents(ad.agents)
      setCurrent(detail)
      setUpdatedAt(Date.now())
      setError('')
    } catch (e) {
      if (version === generation.current) setError(errorText(e))
    } finally {
      if (version === generation.current) setLoading(false)
    }
  }, [teamId, graphId])
  useEffect(() => {
    setCurrent(null)
    setLoading(true)
    setSelected(null)
    setNodeLimit(20)
    setCloseConfirm(false)
    setCloseError('')
    setCloneSource(null)
    setCloneError('')
  }, [teamId, graphId])
  useEffect(() => {
    void refresh()
    const timer = live
      ? setInterval(
          () => {
            void refresh()
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
  const [confirming, setConfirming] = useState<{
    title: string
    description: string
    confirm: string
    run: () => Promise<unknown> | void
  } | null>(null)
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
  const attention = current ? graphAttention(current) : null
  const nodeAttention = node
    ? (attention?.nodes.get(node.id) ?? [])
    : edge
      ? (attention?.edges.get(edge.id) ?? [])
      : []
  const projection = current && node && !isGuidance(node) ? goalProjection(current, node.id) : null
  const reviews = current?.results.filter((r) => r.status === 'review') ?? [],
    blocked =
      current?.assignments.filter(
        (a) => a.role !== 'repair' && ['blocked', 'error', 'reconciling'].includes(a.status)
      ) ?? []
  const liveWeight = (a: GraphAssignment) => current?.scheduler?.candidates.find((c) => c.assignment_id === a.id)?.weight ?? a.priority
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
                  {current.goal_verification === 'true'
                    ? 'Verified'
                    : current.goal_verification === 'false'
                      ? 'Not met'
                      : 'Unverified'}
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
                      ['reply', 'review'].includes(w.action ?? '')
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
                        const proposal = JSON.parse(p.content) as {
                          title?: string
                          description?: string
                          kind?: string
                        }
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
                  <aside className="border-t xl:border-t-0 xl:border-l p-4 space-y-3 text-sm min-w-0">
                    <h3 className="font-semibold">{node?.title ?? edge?.title ?? 'Inspector'}</h3>
                    {nodeAttention.length > 0 && (
                      <section
                        aria-label="Inbox attention"
                        className="rounded border border-amber-500/30 bg-amber-500/10 p-3 space-y-2"
                      >
                        <p className="font-medium text-amber-700 dark:text-amber-400">
                          {nodeAttention.some((a) => a.kind === 'reply')
                            ? 'Waiting for your response'
                            : nodeAttention.some((a) => a.kind === 'review')
                              ? 'Result awaiting review'
                              : 'Recovery in progress'}
                        </p>
                        {nodeAttention.map((item) => (
                          <Button
                            key={item.assignmentId}
                            size="sm"
                            variant="outline"
                            className="w-full"
                            onClick={() =>
                              nav(item.taskId ? `/dashboard/tasks/${item.taskId}` : '/dashboard')
                            }
                          >
                            {item.label}
                          </Button>
                        ))}
                      </section>
                    )}
                    {node ? (
                      <>
                        <Badge variant="outline">
                          {isGuidance(node) ? `Guidance · ${node.kind}` : `${node.kind} · ${node.state}`}
                          {node.reason ? ` / ${node.reason}` : ''}
                        </Badge>
                        {isGuidance(node) && (
                          <p className="text-xs text-muted-foreground">
                            Guidance for planning. This item is not an execution state.
                          </p>
                        )}
                        {projection && (
                          <section
                            aria-label="Projection towards goal"
                            className="rounded border border-blue-500/20 bg-blue-500/5 p-3 space-y-2"
                          >
                            <h4 className="font-medium">Projection towards goal</h4>
                            <p>
                              {projection.evaluated
                                ? `Goal alignment: ${projection.score === null ? 'Unknown' : projection.score.toFixed(2)}`
                                : 'Not evaluated'}
                            </p>
                            <p className="text-xs text-muted-foreground">{projection.reason}</p>
                            <p className="text-xs">
                              Goal verification:{' '}
                              {current.goal_verification === 'true'
                                ? 'Verified'
                                : current.goal_verification === 'false'
                                  ? 'Not met'
                                  : 'Unverified'}
                            </p>
                            {projection.evidenceIds.length > 0 && (
                              <details>
                                <summary className="cursor-pointer text-xs">Projection evidence</summary>
                                <ul className="text-xs break-all mt-2 list-disc pl-4">
                                  {projection.evidenceIds.map((id) => (
                                    <li key={id}>{id}</li>
                                  ))}
                                </ul>
                              </details>
                            )}
                          </section>
                        )}
                        <div className="flex flex-wrap gap-1">
                          {node.tags?.map((tag) => (
                            <Badge variant="secondary" key={tag}>
                              {tag}
                            </Badge>
                          ))}
                        </div>
                        {(current.evidence ?? [])
                          .filter((e) => e.node_id === node.id)
                          .map((e) => (
                            <p className="text-xs" key={`${e.source_result_id}:${e.predicate}`}>
                              {e.predicate}: {e.value} · source {e.resource_id}
                            </p>
                          ))}
                        {isMaintainer && (
                          <div className="flex gap-2">
                            <Input
                              aria-label="New node tag"
                              placeholder="Add tag"
                              maxLength={99}
                              value={input['tag:' + node.id] ?? ''}
                              onChange={(e) => setInput({ ...input, ['tag:' + node.id]: e.target.value })}
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || !input['tag:' + node.id]?.trim()}
                              onClick={() =>
                                command('tag', { node_id: node.id, tag: input['tag:' + node.id] })
                              }
                            >
                              Add
                            </Button>
                          </div>
                        )}
                        <p>{node.description}</p>
                        <p className="whitespace-pre-wrap">{node.body}</p>
                        <p className="text-xs text-muted-foreground">
                          {isGuidance(node) ? 'Created' : 'Observed'} {stamp(node.created_at)}
                        </p>
                      </>
                    ) : edge ? (
                      <>
                        <p>Expected quality: {edge.expected_score ?? 'unknown'}</p>
                        <p>{edge.description}</p>
                        <p className="whitespace-pre-wrap">{edge.body}</p>
                        <b className="block">Baseline</b>
                        <p>{edge.baseline}</p>
                        {(['steps', 'undo_steps', 'predicates', 'resource_versions'] as const).map((key) => (
                          <details key={key} open={key === 'undo_steps'}>
                            <summary className="cursor-pointer font-medium">
                              {
                                {
                                  steps: 'Forward plan',
                                  undo_steps: 'Undo plan',
                                  predicates: 'Restoration predicates',
                                  resource_versions: 'Resource versions'
                                }[key]
                              }
                            </summary>
                            <pre className="whitespace-pre-wrap text-xs py-2 break-all">
                              {pretty(edge[key])}
                            </pre>
                          </details>
                        ))}
                        <p>
                          Declared cost {edge.cost} · recovery {edge.recovery_cost}
                        </p>
                        {current.evaluations
                          .filter((v) => v.edge_id === edge.id)
                          .slice(-4)
                          .map((v) => (
                            <p className="text-xs" key={v.id}>
                              Local {v.local_score ?? 'unknown'} · goal alignment {v.goal_score ?? 'unknown'}{' '}
                              · evidence {v.evidence_id}
                            </p>
                          ))}
                      </>
                    ) : (
                      <p className="text-muted-foreground">
                        Select a node or action to inspect its state, evidence and restoration contract.
                      </p>
                    )}
                    <details open>
                      <summary className="cursor-pointer font-medium">Resources</summary>
                      {node && isMaintainer && (
                        <select
                          aria-label="Attach resource to node"
                          className="my-2 w-full rounded border bg-background p-2"
                          value=""
                          onChange={(e) => {
                            if (e.target.value)
                              void command('link', { node_id: node.id, resource_id: e.target.value })
                          }}
                        >
                          <option value="">Attach resource…</option>
                          {current.resources.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.title} · v{r.version}
                            </option>
                          ))}
                        </select>
                      )}
                      {node &&
                        (current.resource_links ?? [])
                          .filter((l) => l.node_id === node.id)
                          .map((l) => (
                            <p className="text-xs my-2" key={l.resource_id}>
                              Attached: {current.resources.find((r) => r.id === l.resource_id)?.title}
                            </p>
                          ))}

                      <ul className="divide-y">
                        {current.resources
                          .filter(
                            (r) =>
                              !search ||
                              `${r.title} ${r.description} ${r.body}`
                                .toLowerCase()
                                .includes(search.toLowerCase())
                          )
                          .map((r) => (
                            <li key={r.id} className="py-2">
                              <details>
                                <summary className="cursor-pointer">
                                  {r.title} · v{r.version}
                                </summary>
                                <p className="text-xs text-muted-foreground">
                                  {r.visibility} · {r.id}
                                </p>
                                <p>{r.description}</p>
                                <p className="whitespace-pre-wrap pt-2">{r.body}</p>
                              </details>
                            </li>
                          ))}
                      </ul>
                      {isMaintainer && (
                        <Button
                          className="mt-3"
                          size="sm"
                          variant="outline"
                          onClick={() => setResourceOpen(true)}
                        >
                          Add resource
                        </Button>
                      )}
                    </details>
                  </aside>
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
              <GraphSection id="work" title={view === 'activity' ? 'Activity log' : 'Work queue'} help="section_work">
                {tab === 'next' && (
                  <div className="divide-y">
                    {current.assignments
                      .filter((a) => workRank(a.status) < 4)
                      .filter(
                        (a) =>
                          a.status !== 'continuation' ||
                          !current.assignments.some((child) => child.parent_id === a.id)
                      )
                      .sort((a, b) => workRank(a.status) - workRank(b.status) || liveWeight(b) - liveWeight(a))
                      .map((a) => (
                        <div key={a.id} className="flex flex-col gap-3 py-3 text-sm sm:flex-row sm:items-start">
                          <span className="min-w-0 flex-1 break-words">
                            {['reply', 'review'].includes(current.waiting?.[a.id]?.action ?? '') && (
                              <b className="mr-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs">
                                {current.waiting?.[a.id]?.action === 'review'
                                  ? 'Review result'
                                  : current.waiting?.[a.id]?.has_request === false
                                    ? 'Blocked — no approval requested'
                                    : 'Needs your approval or input'}
                              </b>
                            )}
                            {a.role} · {a.status} · priority {liveWeight(a).toFixed(3)} · {a.attempt_count}{' '}
                            attempts
                            {current.waiting?.[a.id]?.request_title && (
                              <strong className="block mt-1">{current.waiting[a.id].request_title}</strong>
                            )}
                            {current.waiting?.[a.id] && (
                              <span className="block text-xs text-muted-foreground mt-1">
                                {current.waiting[a.id].message}
                              </span>
                            )}
                          </span>
                          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-3">
                            {[latestGraphAttempt(current, a.id)]
                              .filter((t) => !!t)
                              .map((t) => (
                                <Link
                                  key={t.id}
                                  className="whitespace-nowrap text-primary underline"
                                  to={`/dashboard/tasks/${t.task_id}`}
                                >
                                  {current.waiting?.[a.id]?.action === 'reply'
                                    ? 'Answer in inbox'
                                    : current.waiting?.[a.id]?.action === 'review'
                                      ? 'Review in inbox'
                                      : 'Open inbox task'}
                                </Link>
                              ))}
                            {isMaintainer &&
                              current.grading.some((r) => r.assignment_id === a.id && r.status === 'blocked') && (
                                <>
                                  <Button size="sm" variant="outline" disabled={busy}
                                    title="Runs a fresh review with a new retry allowance. Previous attempts and evidence are preserved."
                                    onClick={() => command('retry_review', { assignment_id: a.id })}>
                                    Retry review
                                  </Button>
                                  <Button size="sm" variant="outline" disabled={busy}
                                    title="Cancels this review without recording a passing grade or changing the execution evidence."
                                    onClick={() =>
                                      setConfirming({
                                        title: 'Cancel this review?',
                                        description:
                                          'The review is cancelled without a passing grade. The execution result stays ungraded and its evidence unverified; independent work continues. You can regrade it later.',
                                        confirm: 'Cancel review',
                                        run: () => command('cancel_review', { assignment_id: a.id })
                                      })
                                    }>
                                    Cancel review
                                  </Button>
                                </>
                              )}
                            {isMaintainer &&
                              ['decompose', 'plan', 'merge'].includes(a.role) &&
                              ['blocked', 'error'].includes(a.status) && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  title="Marks this planning step as failed, cancels it and queues a fresh attempt. Safe: planning steps have no side effects."
                                  onClick={() => command('fail', { assignment_id: a.id })}
                                >
                                  Fail &amp; retry
                                </Button>
                              )}
                            {isMaintainer &&
                              a.role !== 'repair' &&
                              !['decompose', 'plan', 'merge'].includes(a.role) &&
                              !current.grading.some((r) => r.assignment_id === a.id && r.status === 'blocked') &&
                              ['blocked', 'error'].includes(a.status) && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy}
                                  title="Gives up on this step: cancels it and its follow-ups, deactivates its path and lets the graph move on to other candidates. Nothing is retried, and anything the agent may have left behind stays unverified."
                                  onClick={() =>
                                    setConfirming({
                                      title: 'Abandon this step?',
                                      description:
                                        'It is not retried, its follow-ups are cancelled and its path is deactivated. Anything the agent may have changed stays unverified.',
                                      confirm: 'Abandon',
                                      run: () => command('abandon', { assignment_id: a.id })
                                    })
                                  }
                                >
                                  Abandon
                                </Button>
                              )}
                          </div>
                        </div>
                      ))}
                    {isMaintainer && blocked.length > 0 && (
                      <div className="pt-3">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          title="Cancels blocked steps whose result went out of date, and repair errors. Steps that may hold approvals or side effects are kept."
                          onClick={() => command('dismiss')}
                        >
                          Dismiss out-of-date steps
                        </Button>
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground pt-3">
                      Grading follows durable completion intake. Failed reviews wait for recovery while independent work continues.
                      Dispatch also checks agent availability, role isolation and budgets.
                    </p>
                  </div>
                )}
                {tab === 'activity' && (
                  <ol className="divide-y">
                    {current.events
                      .filter((e) => !range || e.created_at >= now - range)
                      .map((e) => (
                        <li key={e.sequence} className="py-3 text-sm">
                          <span className="text-muted-foreground mr-4">{stamp(e.created_at)}</span>
                          {e.kind.replace(/_/g, ' ')}
                          <details className="text-xs">
                            <summary className="cursor-pointer">Event #{e.sequence}</summary>
                            <pre className="whitespace-pre-wrap">{pretty(e.data)}</pre>
                          </details>
                        </li>
                      ))}
                  </ol>
                )}
              </GraphSection>
            )}
          </div>
        </>
      )}
      <Dialog open={create} onOpenChange={setCreate}>
        <DialogContent className="max-w-3xl sm:max-w-3xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader>
            <DialogTitle>New action graph</DialogTitle>
            <DialogDescription>
              Define an observed baseline and measurable success, then assign existing agents.
            </DialogDescription>
          </DialogHeader>
          <CreateGraph
            teamId={teamId}
            agents={agents}
            onCreated={(g) => {
              setCreate(false)
              nav(`/dashboard/graphs/${g.id}`)
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!cloneSource}
        onOpenChange={(open) => {
          if (!open && !busy) setCloneSource(null)
        }}
      >
        <DialogContent
          className="max-w-[calc(100%_-_2rem)] sm:max-w-lg"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle>Clone “{cloneSource?.title}”</DialogTitle>
            <DialogDescription>
              Create a fresh graph with the same goal, start state, settings and success rule. Results and run
              history are never copied.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Start from the goal with an empty action graph.</p>
              <Button disabled={busy} onClick={() => cloneGraph(false)}>
                Clone without nodes
              </Button>
            </div>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Also copy nodes, actions, plans, resources and tags.
              </p>
              <Button variant="outline" disabled={busy} onClick={() => cloneGraph(true)}>
                Clone with nodes
              </Button>
            </div>
          </div>
          {cloneError && (
            <p role="alert" className="text-sm text-destructive">
              {cloneError}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="max-w-3xl sm:max-w-3xl max-h-[90vh] overflow-y-auto overflow-x-hidden">
          <DialogHeader>
            <DialogTitle>Graph settings</DialogTitle>
            <DialogDescription>
              {current?.status === 'stopped'
                ? 'This graph is closed. Settings are read-only; clone it from the graphs list to start a new graph.'
                : !isMaintainer
                  ? 'Settings are read-only. An owner or maintainer can change this graph.'
                  : 'Pause and resolve existing assignments before creating a configuration revision.'}
            </DialogDescription>
          </DialogHeader>
          {current && (
            <div className="flex flex-wrap items-center gap-2">
              {current.status === 'stopped' ? (
                <>
                  <span className="rounded border px-2 py-1 text-sm text-muted-foreground">Closed</span>
                </>
              ) : isMaintainer ? (
                <>
                  <Button
                    variant="destructive"
                    disabled={busy}
                    title="Close graph permanently: stops all work and cannot be reopened"
                    onClick={() => {
                      setCloseError('')
                      setCloseConfirm(true)
                    }}
                  >
                    Close graph
                  </Button>
                </>
              ) : null}
            </div>
          )}
          {current && (
            <fieldset disabled={current.status === 'stopped' || !isMaintainer} className="space-y-4">
              <PolicyFields
                value={current.status === 'stopped' || !isMaintainer ? current.config.policy : policy}
                onChange={setPolicy}
                agents={agents}
              />
            </fieldset>
          )}
          {current && isMaintainer && current.status !== 'stopped' && (
            <>
              <Button
                disabled={busy}
                onClick={async () => {
                  if (await command('configure', { policy })) setSettings(false)
                }}
              >
                Save revision
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => command('reindex')}>
                Rebuild search index
              </Button>
            </>
          )}
          <AlertDialog
            open={closeConfirm}
            onOpenChange={(open) => {
              if (!busy) setCloseConfirm(open)
            }}
          >
            <AlertDialogContent
              className="w-[calc(100%_-_2rem)] max-w-md"
              onEscapeKeyDown={(event) => {
                if (busy) event.preventDefault()
              }}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>Close this graph?</AlertDialogTitle>
                <AlertDialogDescription>
                  Closing “{current?.title}” is permanent. Work will stop and this graph cannot be reopened.
                  You can clone it later to start a new graph.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {closeError && (
                <p role="alert" className="text-sm text-destructive">
                  {closeError}
                </p>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={busy}
                  onClick={async (event) => {
                    event.preventDefault()
                    if (busy) return
                    setCloseError('')
                    if (await command('stop')) {
                      setCloseConfirm(false)
                      setSettings(false)
                    } else {
                      setCloseError('Could not close this graph. Please try again.')
                    }
                  }}
                >
                  {busy ? 'Closing…' : 'Close graph'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DialogContent>
      </Dialog>
      <Dialog open={resourceOpen} onOpenChange={setResourceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add versioned resource</DialogTitle>
            <DialogDescription>
              Resources are immutable. Add a new version to preserve existing evidence.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault()
              const f = new FormData(e.currentTarget)
              if (await command('resource', Object.fromEntries(f))) setResourceOpen(false)
            }}
          >
            <Label className="grid gap-2">
              Title
              <Input name="title" required maxLength={299} />
            </Label>
            <Label className="grid gap-2">
              Description
              <Input name="description" maxLength={299} />
            </Label>
            <Label className="grid gap-2">
              Content
              <Textarea name="body" maxLength={3999} />
            </Label>
            <Label className="grid gap-2">
              Visibility
              <select name="visibility" className="h-9 border rounded bg-background px-2">
                <option value="execution">Execution context</option>
                <option value="private">Private planning</option>
              </select>
            </Label>
            <Button disabled={busy}>Add resource</Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

import { Play, Pause } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type Agent } from '../lib/api'
import {
  defaultGraphPolicy,
  graphApi,
  type GraphSnapshot,
  type GraphSummary,
  type NewGraph,
  type GraphPolicy,
  type GraphSearchHit,
  type GraphResource
} from '../lib/graph'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { GraphCanvas } from '@/components/GraphCanvas'
import { isGuidance } from '@/lib/graphLayout'
import { goalProjection } from '@/lib/graphProjection'
import { graphAttention } from '@/lib/graphAttention'
import { errorText } from '@/lib/graphError'

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
    <Label className="grid gap-2">
      {label}
      <select
        className="h-9 rounded-md border bg-background px-2"
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
        <legend className="text-sm font-medium">Execution agents</legend>
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
      <div className="grid sm:grid-cols-3 gap-4">
        <Label className="grid gap-2">
          Execution slots
          <Input
            type="number"
            min={1}
            max={32}
            value={value.capacity}
            onChange={(e) => field('capacity', Number(e.target.value))}
          />
        </Label>
        <Label className="grid gap-2">
          Necessity threshold
          <Input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={value.threshold}
            onChange={(e) => field('threshold', Number(e.target.value))}
          />
        </Label>
        <Label className="grid gap-2">
          Result acceptance
          <select
            className="h-9 rounded-md border bg-background px-2"
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
            <Label key={key} className="grid gap-2">
              {label}
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
          {
            {
              title: 'Graph name',
              description: 'Short description',
              body: 'Goal and success definition',
              start_state: 'Observed start state'
            }[key]
          }
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
        Success predicates (one per line)
        <Textarea
          required
          value={predicates}
          onChange={(e) => setPredicates(e.target.value)}
          placeholder="Measured result meets the target over the declared window"
        />
      </Label>
      <div className="grid grid-cols-2 gap-4">
        <Label className="grid gap-2">
          Sufficient rule
          <select
            className="h-9 rounded-md border bg-background px-2"
            value={form.rule.op}
            onChange={(e) => setForm({ ...form, rule: { ...form.rule, op: e.target.value as 'AND' | 'OR' } })}
          >
            <option>AND</option>
            <option>OR</option>
          </select>
        </Label>
        <Label className="grid gap-2">
          Evidence scope
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
  const [graphs, setGraphs] = useState<GraphSummary[]>([]),
    [agents, setAgents] = useState<Agent[]>([]),
    [current, setCurrent] = useState<GraphSnapshot | null>(null)
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [create, setCreate] = useState(false),
    [settings, setSettings] = useState(false)
  const [policy, setPolicy] = useState<GraphPolicy>(defaultGraphPolicy),
    [tab, setTab] = useState<'next' | 'activity' | 'report'>('next'),
    [search, setSearch] = useState(''),
    [showSearch, setShowSearch] = useState(false),
    [selected, setSelected] = useState<string | null>(null)
  const [input, setInput] = useState<Record<string, string>>({}),
    [resourceOpen, setResourceOpen] = useState(false)
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
      setError('')
    } catch (e) {
      if (version === generation.current) setError(errorText(e))
    } finally {
      if (version === generation.current) setLoading(false)
    }
  }, [teamId, graphId])
  useEffect(() => {
    setCurrent(null)
    setSelected(null)
    setLoading(true)
    void refresh()
    const timer = setInterval(
      () => {
        void refresh()
      },
      plan === 'pro' ? 2000 : 5000
    )
    return () => {
      clearInterval(timer)
      generation.current++
    }
  }, [refresh, plan])
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setShowSearch(true)
        setTimeout(() => searchRef.current?.focus(), 0)
      }
      if (e.key === 'Escape') {
        setShowSearch(false)
        setSearch('')
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
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
  const active = current?.attempts.filter((a) => a.status === 'running' || a.status === 'pending') ?? []
  function exportGraph() {
    if (!current) return
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `graph-${current.id}.json`
    link.click()
    URL.revokeObjectURL(url)
  }
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
          {current && (
            <>
              <Button variant="outline" onClick={() => setShowSearch((v) => !v)}>
                Search
              </Button>
              <Button variant="outline" onClick={exportGraph}>
                Export
              </Button>
              {isMaintainer && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setPolicy(current.config.policy)
                    setSettings(true)
                  }}
                >
                  Settings
                </Button>
              )}
            </>
          )}
          {isMaintainer && <Button onClick={() => setCreate(true)}>New graph</Button>}
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
                <Link
                  key={g.id}
                  className="flex items-center justify-between p-4 hover:bg-muted"
                  to={`/dashboard/graphs/${g.id}`}
                >
                  <span>
                    <b>{g.title}</b>
                    <span className="block text-sm text-muted-foreground">{g.description}</span>
                  </span>
                  <Badge variant="outline">{g.status}</Badge>
                </Link>
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
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{current.body}</p>
              <p className="mt-2 text-sm">
                Goal:{' '}
                <b>
                  {current.goal_verification === 'true'
                    ? 'Verified'
                    : current.goal_verification === 'false'
                      ? 'Not met'
                      : 'Unverified'}
                </b>{' '}
                · {current.status} · {current.nodes.filter((n) => !isGuidance(n)).length} execution states ·{' '}
                {current.edges.length} actions · {current.nodes.filter(isGuidance).length} guidance items
              </p>
            </div>
            {isMaintainer && (
              <Button
                size="icon"
                variant={current.status === 'running' ? 'outline' : 'default'}
                disabled={busy}
                aria-label={current.status === 'running' ? 'Pause graph' : 'Run graph'}
                title={current.status === 'running' ? 'Pause graph' : 'Run graph'}
                onClick={() => command(current.status === 'running' ? 'pause' : 'run')}
              >
                {current.status === 'running' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              </Button>
            )}
          </section>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <span>
              {active.length} active jobs · {current.config.policy.capacity} execution slots
            </span>
            <span>
              {reviews.length} awaiting review · {blocked.length} blocked/recovering
            </span>
            <span>
              {current.budgets.attempts} / {current.config.policy.attempt_budget} attempts
            </span>
            <span>
              Declared execution cost: {current.budgets.execution_cost} / {current.config.policy.cost_budget}
            </span>
            <span>
              Recovery reserved: {current.budgets.recovery_reserved} / {current.config.policy.recovery_budget}
            </span>
          </div>
          {active.length > 0 && (
            <section aria-label="Running jobs" className="flex flex-wrap gap-3 text-sm">
              {active.map((t) => (
                <Link key={t.id} className="text-primary underline" to={`/dashboard/tasks/${t.task_id}`}>
                  {agents.find((a) => a.id === t.agent_id)?.name ?? t.agent_id}:{' '}
                  {current.assignments.find((a) => a.id === t.assignment_id)?.role} · {t.status}
                </Link>
              ))}
            </section>
          )}
          {(reviews.length > 0 || blocked.length > 0) && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Replies and result reviews are handled in{' '}
              <Link className="underline font-medium" to="/dashboard">
                Inbox
              </Link>
              . Select a highlighted node to open its task.
            </p>
          )}
          {showSearch && (
            <Input
              ref={searchRef}
              aria-label="Search graph"
              placeholder="Search nodes, edges and resources…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          )}
          {matches && (
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
          {(current.proposals ?? []).some((p) => p.status === 'pending' || p.status === 'uncertain') && (
            <section className="rounded border p-4">
              <h3 className="font-semibold">Proposals awaiting independent review</h3>
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
                        <b>{proposal.title ?? proposal.kind ?? 'Proposal'}</b> · {p.status}
                        <p className="text-muted-foreground">{proposal.description}</p>
                      </li>
                    )
                  })}
              </ul>
            </section>
          )}
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
                      onClick={() => nav(item.taskId ? `/dashboard/tasks/${item.taskId}` : '/dashboard')}
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
                        onClick={() => command('tag', { node_id: node.id, tag: input['tag:' + node.id] })}
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
                      <pre className="whitespace-pre-wrap text-xs py-2 break-all">{pretty(edge[key])}</pre>
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
                        Local {v.local_score ?? 'unknown'} · goal alignment {v.goal_score ?? 'unknown'} ·
                        evidence {v.evidence_id}
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
                        `${r.title} ${r.description} ${r.body}`.toLowerCase().includes(search.toLowerCase())
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
                  <Button className="mt-3" size="sm" variant="outline" onClick={() => setResourceOpen(true)}>
                    Add resource
                  </Button>
                )}
              </details>
            </aside>
          </section>
          <section>
            <div className="flex gap-2 border-b pb-2" role="tablist" aria-label="Graph work">
              {(['next', 'activity', 'report'] as const).map((t) => (
                <Button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  variant={tab === t ? 'secondary' : 'ghost'}
                  onClick={() => setTab(t)}
                >
                  {{ next: 'Up next', activity: 'Activity', report: 'Daily report' }[t]}
                </Button>
              ))}
            </div>
            {tab === 'next' && (
              <div className="divide-y">
                {current.assignments
                  .filter((a) => ['pending', 'running', 'review'].includes(a.status))
                  .sort((a, b) => b.priority - a.priority)
                  .map((a) => (
                    <div key={a.id} className="py-3 text-sm flex justify-between gap-3">
                      <span>
                        {a.role} · {a.status} · priority {a.priority.toFixed(2)} · {a.attempt_count} attempts
                      </span>
                      {current.attempts
                        .filter((t) => t.assignment_id === a.id)
                        .slice(-1)
                        .map((t) => (
                          <Link
                            key={t.id}
                            className="text-primary underline"
                            to={`/dashboard/tasks/${t.task_id}`}
                          >
                            Open inbox task
                          </Link>
                        ))}
                    </div>
                  ))}
                <p className="text-xs text-muted-foreground pt-3">
                  Grading follows durable completion intake. Review at the head holds later grades. Dispatch
                  also checks agent availability, role isolation and budgets.
                </p>
              </div>
            )}
            {tab === 'activity' && (
              <ol className="divide-y">
                {current.events.map((e) => (
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
            {tab === 'report' && (
              <div className="space-y-4 pt-4">
                <p className="text-sm">
                  Today ({new Date().toISOString().slice(0, 10)}, UTC) · goal {current.goal_verification}
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
                        · completed {stamp(t.completed_at)} · {r?.status ?? 'grade pending'} · accepted{' '}
                        {stamp(r?.accepted_at ?? null)}
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
                {current.nodes.map((n) => (
                  <p className="text-sm" key={n.id}>
                    {n.title} · {n.state} ·{' '}
                    {new Date(Math.max(n.created_at, n.state_changed_at ?? 0)).toISOString().slice(0, 10) ===
                      new Date().toISOString().slice(0, 10) ||
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
              </div>
            )}
          </section>
        </>
      )}
      <Dialog open={create} onOpenChange={setCreate}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
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
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Graph settings</DialogTitle>
            <DialogDescription>
              Pause and resolve existing assignments before creating a configuration revision.
            </DialogDescription>
          </DialogHeader>
          <PolicyFields value={policy} onChange={setPolicy} agents={agents} />
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

import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Activity, Archive, CircleCheck, Clock3, Layers3, ListFilter, Network, Target } from 'lucide-react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import {
  assignmentTitle,
  duration,
  executionStats,
  predicateState,
  score,
  staleJobs,
  type GraphView
} from '@/lib/graphDashboard'
import { effectiveRole, latestGraphAttempt, type GraphAssignment, type GraphSnapshot } from '@/lib/graph'
import { goalProjection } from '@/lib/graphProjection'
import { summarize } from '@/lib/graphReport'

export function DashboardPanel({
  title,
  description,
  children,
  className = ''
}: {
  title: string
  description?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`min-w-0 rounded-lg border bg-card ${className}`}>
      <header className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}
export function Metric({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-4 py-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {detail && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
    </div>
  )
}
function Empty({ children }: { children: ReactNode }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">{children}</p>
}
function TaskLink({ graph, assignment }: { graph: GraphSnapshot; assignment: GraphAssignment }) {
  const task = latestGraphAttempt(graph, assignment.id)
  return task ? (
    <Link
      className="shrink-0 text-sm text-primary underline underline-offset-4"
      to={`/dashboard/tasks/${task.task_id}`}
    >
      Open task
    </Link>
  ) : null
}

export function GraphMetrics({ graph }: { graph: GraphSnapshot }) {
  const active = graph.attempts.filter((a) => ['pending', 'running'].includes(a.status)).length
  const needsInput = Object.values(graph.waiting ?? {}).filter((w) =>
    ['reply', 'review'].includes(w.action ?? '')
  ).length
  const pending = graph.assignments.filter((a) => a.status === 'pending').length
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Metric
        label="Goal evidence"
        value={
          graph.goal_verification === 'true'
            ? 'Verified'
            : graph.goal_verification === 'false'
              ? 'Not met'
              : 'Unverified'
        }
        detail={`${graph.config.rule.predicates.length} success predicates`}
      />
      <Metric label="Active jobs" value={active} detail={`${graph.config.policy.capacity} execution slots`} />
      <Metric
        label="Pending work"
        value={pending}
        detail={`${graph.scheduler?.heap.length ?? '—'} execution candidates in heap`}
      />
      <Metric label="Needs your attention" value={needsInput} detail="Input and result reviews" />
    </div>
  )
}

function Candidates({ graph, inspect }: { graph: GraphSnapshot; inspect: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const data = graph.scheduler
  if (!data)
    return (
      <DashboardPanel title="Live candidate weights">
        <Empty>Scheduler telemetry is unavailable. Refresh after the API update.</Empty>
      </DashboardPanel>
    )
  const byId = new Map(graph.assignments.map((a) => [a.id, a]))
  const weights = new Map(data.candidates.map((c) => [c.assignment_id, c]))
  const heap = data.heap.map((id) => byId.get(id)!).filter(Boolean)
  const candidate = byId.get(selected && weights.has(selected) ? selected : (heap[0]?.id ?? ''))
  const details = candidate && weights.get(candidate.id)
  // Binary heap array positions, not a sorted ranking. Every parent is >= its children.
  const visibleHeap = heap.slice(0, 15)
  const maxDepth = Math.max(0, Math.floor(Math.log2(Math.max(1, visibleHeap.length))))
  const position = (i: number) => {
    const depth = Math.floor(Math.log2(i + 1)),
      offset = i - (2 ** depth - 1)
    return { x: ((offset + 0.5) / 2 ** depth) * 960, y: depth * 88 + 42 }
  }
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Execution candidates"
          value={heap.length}
          detail="Available by time; eligibility still applies"
        />
        <Metric label="Highest weight" value={heap.length ? score(weights.get(heap[0].id)?.weight) : '—'} />
        <Metric
          label="Next heap selection"
          value={data.next_selection === 'lowest' ? 'Explore' : 'Highest'}
          detail="Every fifth allocation samples the lowest weight"
        />
        <Metric
          label="Serial reviews ahead"
          value={data.serial_queue.length}
          detail="Control work runs before execution candidates"
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <DashboardPanel
          title="Execution max heap"
          description="Live scheduler weights. Select a candidate to inspect its evidence and dispatch gate."
        >
          {heap.length ? (
            <div className="max-h-[480px] overflow-auto rounded-md bg-muted/20">
              <svg
                role="group"
                aria-label="Candidate max heap"
                viewBox={`0 0 960 ${(maxDepth + 1) * 88}`}
                className="w-full"
                style={{ minWidth: 640 }}
              >
                {visibleHeap.slice(1).map((a, index) => {
                  const p = position(Math.floor(index / 2)),
                    c = position(index + 1)
                  return (
                    <line
                      key={a.id}
                      x1={p.x}
                      y1={p.y + 20}
                      x2={c.x}
                      y2={c.y - 20}
                      className="stroke-border"
                      strokeWidth="2"
                    />
                  )
                })}
                {visibleHeap.map((a, i) => {
                  const p = position(i),
                    w = weights.get(a.id)!,
                    isSelected = candidate?.id === a.id
                  return (
                    <g
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${assignmentTitle(graph, a)}, weight ${w.weight}`}
                      aria-pressed={isSelected}
                      onClick={() => setSelected(a.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSelected(a.id)
                        }
                      }}
                      className="cursor-pointer focus:outline focus:outline-2 focus:outline-primary"
                      transform={`translate(${p.x},${p.y})`}
                    >
                      <title>
                        {assignmentTitle(graph, a)} ·{' '}
                        {graph.waiting?.[a.id]?.message ?? 'Eligibility pending'}
                      </title>
                      <rect
                        x="-43"
                        y="-23"
                        width="86"
                        height="46"
                        rx="8"
                        className={isSelected ? 'fill-primary stroke-primary' : 'fill-card stroke-border'}
                      />
                      <text
                        textAnchor="middle"
                        y="-1"
                        className={isSelected ? 'fill-primary-foreground' : 'fill-foreground'}
                        fontSize="15"
                        fontWeight="600"
                      >
                        {score(w.weight)}
                      </text>
                      <text
                        textAnchor="middle"
                        y="15"
                        className={isSelected ? 'fill-primary-foreground' : 'fill-muted-foreground'}
                        fontSize="11"
                      >
                        Candidate {i + 1}
                      </text>
                    </g>
                  )
                })}
              </svg>
            </div>
          ) : (
            <Empty>No execution candidates are currently in the heap.</Empty>
          )}
          {heap.length > visibleHeap.length && (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing the first {visibleHeap.length} of {heap.length} heap entries. All candidates appear in
              the weight list below.
            </p>
          )}
        </DashboardPanel>
        <DashboardPanel
          title="Weight inspector"
          description="Heuristic priority, not a probability of success."
        >
          {candidate && details ? (
            <div className="space-y-4 text-sm">
              <h4 className="font-medium">{assignmentTitle(graph, candidate)}</h4>
              <p className="break-all text-xs text-muted-foreground">{candidate.id}</p>
              <div className="text-3xl font-semibold tabular-nums">{score(details.weight)}</div>
              <dl className="grid grid-cols-2 gap-2">
                <dt>Expected quality</dt>
                <dd>{score(graph.edges.find((e) => e.id === candidate.edge_id)?.expected_score)}</dd>
                <dt>Observed quality</dt>
                <dd>{score(details.local_score)}</dd>
                <dt>Goal alignment</dt>
                <dd>{score(details.goal_score)}</dd>
                <dt>Evidence visits</dt>
                <dd>{details.evidence_count}</dd>
                <dt>Latest evaluation</dt>
                <dd>{details.observed_at ? new Date(details.observed_at).toLocaleString() : 'None'}</dd>
              </dl>
              <p className="rounded-md bg-muted p-3">
                {graph.waiting?.[candidate.id]?.message ?? 'Waiting for dispatch diagnostics.'}
              </p>
              <p className="text-xs text-muted-foreground">
                Weight = 60% quality + 20% uncertainty + 10% freshness + 10% recovery. Quality combines
                observed local and goal scores; absent scores use a neutral prior.
              </p>
              {candidate.node_id && (
                <Button variant="outline" size="sm" onClick={() => inspect(candidate.node_id!)}>
                  Inspect on graph
                </Button>
              )}
              <TaskLink graph={graph} assignment={candidate} />
            </div>
          ) : (
            <Empty>Select a candidate.</Empty>
          )}
        </DashboardPanel>
      </div>
      <DashboardPanel
        title="Candidate weights and dispatch gates"
        description="Includes delayed candidates outside the heap. A high weight does not override permissions, recovery, agent availability, or budgets."
      >
        <Input
          aria-label="Filter candidates"
          placeholder="Filter candidates…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mb-3 max-w-sm"
        />
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Candidate</th>
                <th className="p-2">Weight</th>
                <th className="p-2">Local / goal</th>
                <th className="p-2">Dispatch gate</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...data.candidates]
                .sort((a, b) => b.weight - a.weight || a.assignment_id.localeCompare(b.assignment_id))
                .filter((c) => {
                  const a = byId.get(c.assignment_id)
                  return (
                    a && `${assignmentTitle(graph, a)} ${a.role}`.toLowerCase().includes(filter.toLowerCase())
                  )
                })
                .map((c) => {
                  const a = byId.get(c.assignment_id)!
                  return (
                    <tr key={a.id} className="hover:bg-muted/40">
                      <td className="p-2">
                        <button
                          className="text-left font-medium hover:underline"
                          onClick={() => setSelected(a.id)}
                        >
                          {assignmentTitle(graph, a)}
                        </button>
                        <p className="text-xs text-muted-foreground">
                          {a.role} · {a.id.slice(-8)}
                        </p>
                      </td>
                      <td className="p-2 tabular-nums">{score(c.weight)}</td>
                      <td className="p-2 tabular-nums">
                        {score(c.local_score)} / {score(c.goal_score)}
                      </td>
                      <td className="max-w-sm p-2 text-muted-foreground">
                        {graph.waiting?.[a.id]?.message ?? 'No diagnostic'}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
          {!data.candidates.length && <Empty>No pending candidates.</Empty>}
        </div>
      </DashboardPanel>
    </div>
  )
}

export function GoalState({
  graph,
  inspect,
  now
}: {
  graph: GraphSnapshot
  inspect: (id: string) => void
  now: number
}) {
  const observed = graph.nodes.filter(
    (n) =>
      n.state === 'active' && ['observed', 'outcome', 'restoration'].includes(n.kind) && n.source_result_id
  )
  const projections = observed
    .map((n) => ({ node: n, projection: goalProjection(graph, n.id) }))
    .filter((p) => p.projection.evaluated)
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <DashboardPanel
        title="Goal state"
        description={`${graph.config.rule.op === 'AND' ? 'All' : 'Any'} of these predicates must be verified in ${graph.config.rule.scope}.`}
      >
        <ul className="divide-y">
          {graph.config.rule.predicates.map((predicate) => {
            const state = predicateState(graph, predicate, now)
            return (
              <li key={predicate} className="flex items-start gap-3 py-3 text-sm">
                <CircleCheck
                  className={`mt-0.5 h-4 w-4 shrink-0 ${state === 'Verified' ? 'text-emerald-600' : 'text-muted-foreground'}`}
                />
                <span className="flex-1">{predicate}</span>
                <Badge variant="outline">{state}</Badge>
              </li>
            )
          })}
        </ul>
      </DashboardPanel>
      <DashboardPanel
        title="Observed goal alignment"
        description="Independent projections from accepted execution results. These scores are not sales forecasts or goal verification."
      >
        <div className="max-h-[480px] overflow-y-auto space-y-4">
          {projections.length ? (
            projections.map(({ node, projection }) => (
              <div key={node.id} className="space-y-2 border-b pb-3 last:border-0">
                <div className="flex items-start justify-between gap-3">
                  <button
                    className="text-left text-sm font-medium hover:underline"
                    onClick={() => inspect(node.id)}
                  >
                    {node.title}
                  </button>
                  <span className="font-mono text-sm">{score(projection.score)}</span>
                </div>
                <div className="h-1.5 rounded bg-muted">
                  <div
                    className="h-full rounded bg-blue-500"
                    style={{ width: `${(projection.score ?? 0) * 100}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">{projection.reason}</p>
              </div>
            ))
          ) : (
            <Empty>No accepted goal projections yet.</Empty>
          )}
        </div>
      </DashboardPanel>
      <DashboardPanel
        title="Planning predictions"
        className="xl:col-span-2"
        description="Expected local quality proposed by planners, on a 0–1 scale. Estimates are not verified outcomes or business-success probabilities."
      >
        <div className="max-h-80 overflow-y-auto divide-y">
          {graph.edges
            .filter((e) => e.expected_score !== null)
            .map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                <button className="text-left hover:underline" onClick={() => inspect(e.id)}>
                  {e.title}
                </button>
                <span className="shrink-0 font-mono">Expected quality {score(e.expected_score)}</span>
              </div>
            ))}
          {!graph.edges.some((e) => e.expected_score !== null) && (
            <Empty>No planning predictions have been recorded.</Empty>
          )}
        </div>
      </DashboardPanel>
    </div>
  )
}

function Stale({ graph, now }: { graph: GraphSnapshot; now: number }) {
  const [age, setAge] = useState(3600_000)
  const jobs = staleJobs(graph, now, age)
  const outdated = graph.results.filter((r) => ['stale', 'invalid', 'rejected'].includes(r.status))
  return (
    <div className="space-y-4">
      <DashboardPanel
        title="Stale and unresolved jobs"
        description="Overdue active attempts, expired candidates, timeouts, and work waiting longer than the selected threshold."
      >
        <label className="mb-4 flex items-center gap-2 text-sm">
          Waiting threshold
          <select
            aria-label="Waiting threshold"
            className="rounded border bg-background p-2"
            value={age}
            onChange={(e) => setAge(Number(e.target.value))}
          >
            <option value={900000}>15 minutes</option>
            <option value={3600000}>1 hour</option>
            <option value={21600000}>6 hours</option>
            <option value={86400000}>24 hours</option>
          </select>
        </label>
        <div className="divide-y">
          {jobs.map(({ assignment: a, attempt, age, diagnosis }) => (
            <div key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{assignmentTitle(graph, a)}</p>
                <p className="mt-1 text-muted-foreground">
                  {a.role} · {a.status} · age {duration(age)}
                  {attempt ? ` · deadline ${new Date(attempt.deadline).toLocaleString()}` : ''}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {graph.waiting?.[a.id]?.message ?? 'Inspect the latest task and result before retrying.'}
                </p>
              </div>
              <Badge variant="outline">{diagnosis}</Badge>
              <TaskLink graph={graph} assignment={a} />
            </div>
          ))}
          {!jobs.length && <Empty>No jobs match the current threshold.</Empty>}
        </div>
      </DashboardPanel>
      <DashboardPanel
        title="Out-of-date and rejected results"
        description="Historical results retained for diagnosis, including results later repaired. These do not all represent currently stuck jobs."
      >
        <div className="max-h-96 overflow-y-auto divide-y">
          {outdated.map((r) => {
            const attempt = graph.attempts.find((a) => a.id === r.attempt_id)
            return (
              <details key={r.id} className="py-3 text-sm">
                <summary className="cursor-pointer">
                  {r.status} · {new Date(r.created_at).toLocaleString()} ·{' '}
                  {r.validation_error ?? summarize(r.parsed ?? r.raw)}
                </summary>
                <div className="pt-2 space-y-2">
                  {attempt && (
                    <Link className="underline" to={`/dashboard/tasks/${attempt.task_id}`}>
                      Open task
                    </Link>
                  )}
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{r.raw}</pre>
                </div>
              </details>
            )
          })}
          {!outdated.length && <Empty>No out-of-date results.</Empty>}
        </div>
      </DashboardPanel>
    </div>
  )
}

function Statistics({ graph, since, now }: { graph: GraphSnapshot; since: number; now: number }) {
  const stats = executionStats(graph, since, now)
  const peak = Math.max(1, ...stats.buckets.map((b) => b.completed + b.timeout))
  const runs = graph.results.filter(
    (r) =>
      r.created_at >= since &&
      r.status === 'accepted' &&
      effectiveRole(graph, graph.attempts.find((t) => t.id === r.attempt_id)?.assignment_id) === 'execute'
  )
  const outcomes = runs.map((r) => {
    try {
      return JSON.parse(r.parsed ?? '{}').outcome
    } catch {
      return 'unknown'
    }
  })
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Finished attempts"
          value={stats.finished.length}
          detail="All roles, including timeouts"
        />
        <Metric label="Median duration" value={stats.median === null ? '—' : duration(stats.median)} />
        <Metric label="P95 duration" value={stats.p95 === null ? '—' : duration(stats.p95)} />
        <Metric
          label="Accepted results"
          value={stats.results ? `${Math.round((stats.accepted / stats.results) * 100)}%` : '—'}
          detail={`${stats.accepted} of ${stats.results} received in this window`}
        />
      </div>
      <DashboardPanel
        title="Attempt throughput"
        description="Finished attempts by completion time. Timeouts are shown separately."
      >
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 bg-blue-500" />
            Finished
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 bg-amber-500" />
            Timeout
          </span>
        </div>
        <svg
          viewBox="0 0 960 180"
          className="mt-3 w-full"
          role="img"
          aria-label={`${stats.finished.length} finished attempts including ${stats.timeouts} timeouts across 24 time buckets`}
        >
          {[0, 0.5, 1].map((v) => (
            <g key={v}>
              <line x1="30" x2="960" y1={150 - v * 130} y2={150 - v * 130} className="stroke-border" />
              <text x="0" y={154 - v * 130} fontSize="11" className="fill-muted-foreground">
                {Math.round(peak * v)}
              </text>
            </g>
          ))}
          {stats.buckets.map((b, i) => (
            <g key={b.at}>
              <title>
                {new Date(b.at).toLocaleString()}: {b.completed} finished, {b.timeout} timed out
              </title>
              <rect
                x={35 + i * 38.3}
                y={150 - (b.completed / peak) * 130}
                width="26"
                height={(b.completed / peak) * 130}
                rx="2"
                className="fill-blue-500"
              />
              <rect
                x={35 + i * 38.3}
                y={150 - ((b.completed + b.timeout) / peak) * 130}
                width="26"
                height={(b.timeout / peak) * 130}
                className="fill-amber-500"
              />
            </g>
          ))}
          <text x="30" y="175" fontSize="11" className="fill-muted-foreground">
            {new Date(stats.buckets[0].at).toLocaleString()}
          </text>
          <text x="955" y="175" textAnchor="end" fontSize="11" className="fill-muted-foreground">
            {new Date(now).toLocaleString()}
          </text>
        </svg>
      </DashboardPanel>
      <div className="grid gap-4 lg:grid-cols-2">
        <DashboardPanel title="Work by role">
          <div className="space-y-3">
            {stats.roles
              .sort((a, b) => b.finished - a.finished)
              .map((r) => (
                <div key={r.role} className="text-sm">
                  <div className="mb-1 flex justify-between">
                    <span>{r.role}</span>
                    <span className="tabular-nums">
                      {r.finished} finished · {r.timeouts} timeouts · avg {duration(r.duration / r.finished)}
                    </span>
                  </div>
                  <div className="h-2 rounded bg-muted">
                    <div
                      className="h-2 rounded bg-blue-500/70"
                      style={{ width: `${(r.finished / Math.max(1, stats.finished.length)) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            {!stats.roles.length && <Empty>No finished attempts in this window.</Empty>}
          </div>
        </DashboardPanel>
        <DashboardPanel
          title="Execution outcomes"
          description="Accepted execution results only. Step completion is separate from achieving the graph goal."
        >
          <div className="grid grid-cols-2 gap-3">
            <Metric label="Complete" value={outcomes.filter((o) => o === 'complete').length} />
            <Metric label="Blocked" value={outcomes.filter((o) => o === 'blocked').length} />
            <Metric label="Failed" value={outcomes.filter((o) => o === 'failed').length} />
            <Metric
              label="Other / unknown"
              value={outcomes.filter((o) => !['complete', 'blocked', 'failed'].includes(o)).length}
            />
          </div>
        </DashboardPanel>
      </div>
      <DashboardPanel
        title="Lifetime budget utilization"
        description="Engine-declared cost units; this is not a cash-spend ledger. Budgets are lifetime totals, independent of the selected time window."
      >
        <div className="grid gap-5 md:grid-cols-3">
          {[
            ['Attempts', graph.budgets.attempts, graph.config.policy.attempt_budget],
            ['Execution cost', graph.budgets.execution_cost, graph.config.policy.cost_budget],
            ['Recovery reserved', graph.budgets.recovery_reserved, graph.config.policy.recovery_budget]
          ].map(([label, used, limit]) => (
            <div key={label} className="text-sm">
              <div className="mb-2 flex justify-between gap-2">
                <span>{label}</span>
                <b className="tabular-nums">
                  {used} / {limit}
                </b>
              </div>
              <div className="h-2 rounded bg-muted">
                <div
                  className="h-2 rounded bg-primary"
                  style={{
                    width: `${Math.min(100, Number(limit) > 0 ? (Number(used) / Number(limit)) * 100 : 0)}%`
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </DashboardPanel>
    </div>
  )
}

export function GraphDashboardPanels({
  view,
  graph,
  inspect,
  since,
  now
}: {
  view: GraphView
  graph: GraphSnapshot
  inspect: (id: string) => void
  since: number
  now: number
}) {
  if (view === 'candidates') return <Candidates graph={graph} inspect={inspect} />
  if (view === 'stale') return <Stale graph={graph} now={now} />
  if (view === 'statistics') return <Statistics graph={graph} since={since} now={now} />
  if (view === 'deactivated') {
    const nodes = graph.nodes.filter((n) => n.state === 'deactivated')
    return (
      <DashboardPanel
        title="Deactivated nodes"
        description="Retired paths and their recorded reasons. History and evidence remain available for inspection."
      >
        <div className="divide-y">
          {nodes.map((n) => (
            <div key={n.id} className="flex items-start justify-between gap-4 py-4 text-sm">
              <div>
                <h4 className="font-medium">{n.title}</h4>
                <p className="mt-1 text-muted-foreground">
                  {n.kind} · {n.reason ?? 'No reason recorded'} ·{' '}
                  {new Date(n.state_changed_at ?? n.created_at).toLocaleString()}
                </p>
                <p className="mt-2 text-muted-foreground">{n.description}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => inspect(n.id)}>
                Inspect node
              </Button>
            </div>
          ))}
          {!nodes.length && <Empty>No deactivated nodes.</Empty>}
        </div>
      </DashboardPanel>
    )
  }
  return null
}

export const graphViewIcons = {
  home: Network,
  candidates: Layers3,
  inbox: ListFilter,
  stale: Clock3,
  deactivated: Archive,
  goals: Target,
  statistics: Activity,
  activity: Activity
}

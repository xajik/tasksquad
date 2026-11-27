import { useMemo, useRef, useState } from 'react'
import { ChevronDown, CornerLeftUp } from 'lucide-react'
import type { Agent } from '@/lib/api'
import type { GraphSnapshot } from '@/lib/graph'
import { score } from '@/lib/graphDashboard'
import { executionGrade, rankedPlans, type RankedPlan } from '@/lib/graphPredictions'
import { parseJson } from '@/lib/parseJson'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import './GraphPredictionTree.css'

function PlanDetails({
  graph,
  plan,
  agents,
  inspect
}: {
  graph: GraphSnapshot
  plan: RankedPlan
  agents: Agent[]
  inspect: (id: string) => void
}) {
  const { edge, source, work } = plan
  const grade = executionGrade(graph, work)
  const agentId = grade?.agentId || graph.config.policy.grader
  const agent = agents.find((a) => a.id === agentId)?.name || agentId
  const steps = parseJson<unknown>(edge.steps, [])
  const gate = work && graph.waiting?.[work.id]
  return (
    <>
      <DialogTitle className="pr-6 leading-snug">{edge.title}</DialogTitle>
      <DialogDescription>
        Predicted quality {score(edge.expected_score)} · {work?.status ?? 'Unscheduled'}
      </DialogDescription>
      <section className="space-y-1">
        <h4 className="font-semibold">Plan</h4>
        {edge.description && <p>{edge.description}</p>}
        {edge.body && edge.body !== edge.description && <p className="whitespace-pre-wrap">{edge.body}</p>}
        {Array.isArray(steps) && steps.length > 0 && (
          <ol className="list-decimal space-y-1 pl-5">
            {steps.map((step, i) => (
              <li key={i}>{String(step)}</li>
            ))}
          </ol>
        )}
      </section>
      <section className="space-y-1 border-t pt-3">
        <h4 className="font-semibold">Grader</h4>
        <p>
          {grade ? 'Graded by' : 'Configured grader'} · {agent || 'Unassigned'}
        </p>
        <p className="text-muted-foreground">
          {grade ? `Observed quality · ${score(grade.local_score)}` : 'No accepted grade yet.'}
        </p>
        {grade?.reason && <p>{grade.reason}</p>}
      </section>
      <section className="space-y-1 border-t pt-3">
        <h4 className="font-semibold">Observed starting state</h4>
        <p>
          {source.title} · {source.state}
        </p>
        {source.description && <p className="text-muted-foreground">{source.description}</p>}
        {source.body && source.body !== source.description && (
          <p className="whitespace-pre-wrap">{source.body}</p>
        )}
        {gate && <p className="mt-2 text-muted-foreground">{gate.message}</p>}
      </section>
      <Button className="justify-self-start" variant="outline" size="sm" onClick={() => inspect(edge.id)}>
        Inspect on graph
      </Button>
    </>
  )
}

export function GraphPredictionTree({
  graph,
  observations,
  agents,
  inspect
}: {
  graph: GraphSnapshot
  observations: ReadonlySet<string>
  agents: Agent[]
  inspect: (id: string) => void
}) {
  const plans = useMemo(() => rankedPlans(graph, observations), [graph, observations])
  const pending = plans.filter((plan) => plan.pending)
  const [scope, setScope] = useState<'pending' | 'all'>(() => (pending.length ? 'pending' : 'all'))
  const [branch, setBranch] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const triggerId = useRef<string | null>(null)
  const selected = plans.find((plan) => plan.edge.id === selectedId)
  const visible = scope === 'pending' ? pending : plans
  const root = Math.max(
    0,
    visible.findIndex((plan) => plan.edge.id === branch)
  )

  function renderBranch(index: number, depth: number) {
    const plan = visible[index]
    if (!plan) return null
    const left = 2 * index + 1
    const hasChildren = left < visible.length
    const red = Math.floor(Math.log2(index + 1)) % 2 === 1
    return (
      <li className="prediction-branch" key={plan.edge.id}>
        <button
          className="prediction-node"
          type="button"
          id={`prediction-${plan.edge.id}`}
          aria-haspopup="dialog"
          onClick={(event) => {
            triggerId.current = event.currentTarget.id
            setSelectedId(plan.edge.id)
          }}
        >
          <span className="flex items-center justify-between gap-1">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold tabular-nums">
              <span
                aria-hidden="true"
                className={`h-3 w-3 rounded-full border border-white/40 ${red ? 'bg-rose-700' : 'bg-zinc-950'}`}
              />
              <span className="sr-only">Predicted quality </span>
              {plan.edge.expected_score == null ? 'Unscored' : score(plan.edge.expected_score)}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">#{index + 1}</span>
          </span>
          <span className="line-clamp-2 min-h-[2.75em] text-sm font-medium leading-snug">
            {plan.edge.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{plan.source.title}</span>
        </button>
        {hasChildren && depth > 0 && (
          <button
            type="button"
            className={`prediction-drill ${depth === 1 ? 'narrow-only' : ''}`}
            aria-label={`View branches under ${plan.edge.title}`}
            onClick={() => setBranch(plan.edge.id)}
          >
            View branches <ChevronDown size={12} />
          </button>
        )}
        {hasChildren && depth < 2 && (
          <ol className={`prediction-children ${depth === 1 ? 'wide-only' : ''}`}>
            {renderBranch(left, depth + 1)}
            {renderBranch(left + 1, depth + 1)}
          </ol>
        )}
      </li>
    )
  }

  return (
    <section
      aria-label="Execution candidate tree"
      className="min-w-0 overflow-hidden rounded-lg border bg-card"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Execution candidate tree</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Highest predicted quality first, ranked left to right at each level.
          </p>
        </div>
        <select
          id="prediction-scope"
          aria-label="Plans shown in tree"
          value={scope}
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
          onChange={(e) => {
            setScope(e.target.value === 'pending' ? 'pending' : 'all')
            setBranch(null)
          }}
        >
          <option value="pending">Pending executions ({pending.length})</option>
          <option value="all">All plans ({plans.length})</option>
        </select>
      </header>
      {root > 0 && (
        <Button variant="ghost" size="sm" className="ml-2 mt-2" onClick={() => setBranch(null)}>
          <CornerLeftUp size={14} /> Back to highest score
        </Button>
      )}
      {visible.length ? (
        <div className="prediction-tree">
          <ol>{renderBranch(root, 0)}</ol>
        </div>
      ) : (
        <p className="p-8 text-center text-sm text-muted-foreground">
          {scope === 'pending'
            ? 'No executions are pending from an active observed state.'
            : 'No plans from observed states yet.'}
        </p>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
      >
        <DialogContent
          className="max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto break-words text-sm"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            window.setTimeout(() => {
              const trigger = triggerId.current && document.getElementById(triggerId.current)
              if (trigger && trigger.getClientRects().length) trigger.focus()
              else document.getElementById('prediction-scope')?.focus()
            }, 0)
          }}
        >
          {selected && <PlanDetails graph={graph} plan={selected} agents={agents} inspect={inspect} />}
        </DialogContent>
      </Dialog>
    </section>
  )
}

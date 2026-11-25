import { useEffect, useState } from 'react'
import { GraphPhaseBadge } from './GraphPhaseBadge'
import { Link } from 'react-router-dom'
import type { GraphInboxContext } from '@/lib/api'
import { graphApi, type GraphSnapshot, type GraphResult } from '@/lib/graph'
import { errorText } from '@/lib/graphError'
import { summarizeResult, type SummaryContext } from '@/lib/graphSummary'
import { Button } from './ui/button'

/** Inbox owns exact-output review; the thread's regular composer owns recovery replies. */
export function GraphInboxPanel({
  taskId,
  context,
  interval,
  onChange
}: {
  taskId: string
  context: GraphInboxContext
  interval: number
  onChange: () => void
}) {
  const [graph, setGraph] = useState<GraphSnapshot | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    setGraph(null)
    setError('')
    setNotice('')
    async function load() {
      try {
        const next = await graphApi.get(context.team_id, context.graph_id)
        if (active) setGraph(next)
      } catch (e) {
        if (active) setError(errorText(e))
      }
    }
    void load()
    const timer = setInterval(() => {
      void load()
    }, interval)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [taskId, context.team_id, context.graph_id, interval])
  const attemptIds = new Set(graph?.attempts.filter((a) => a.task_id === taskId).map((a) => a.id))
  const reviews = graph?.results.filter((r) => r.status === 'review' && attemptIds.has(r.attempt_id)) ?? []
  async function review(result: GraphResult, verdict: string) {
    if (!graph) return
    setBusy(true)
    setError('')
    try {
      await graphApi.command(context.team_id, context.graph_id, 'review', {
        result_id: result.id,
        output_hash: result.output_hash,
        config_version: graph.config.version,
        verdict
      })
      setGraph(await graphApi.get(context.team_id, context.graph_id))
      setNotice(
        verdict === 'accept'
          ? 'Accepted. The graph applies this result and moves to the next step.'
          : 'Rejected. This step is blocked; reply in this thread to continue it.'
      )
      onChange()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      aria-label="Graph inbox task"
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3 mb-4"
    >
      <div className="flex justify-between gap-3 flex-wrap">
        <strong className="text-sm">
          <GraphPhaseBadge role={context.role} />
          Graph task · {context.role}
        </strong>
        <Link className="text-sm underline" to={`/dashboard/graphs/${context.graph_id}`}>
          Open graph
        </Link>
      </div>
      {context.can_reply && (
        <p className="text-sm">
          This {context.role} step is blocked — either the agent asked for input or a result was rejected. Reply
          in this thread to request a checked continuation.
        </p>
      )}
      {!context.can_manage && ['blocked', 'error'].includes(context.status) && (
        <p className="text-sm">An owner or maintainer must reply to continue this task.</p>
      )}
      {context.status === 'continuation' && (
        <p className="text-sm">
          Reply received. A continuation is checking the checkpoint; follow-up work appears as a new inbox
          task.
        </p>
      )}
      {!context.latest && (
        <p className="text-sm text-muted-foreground">
          This is an earlier attempt. Continue the conversation in the latest inbox task.
        </p>
      )}
      {reviews.map((result) => (
        <article key={result.id} className="space-y-2">
          <h3 className="text-sm font-medium">
            <GraphPhaseBadge role={context.role} />
            Review {context.role} result
          </h3>
          {(() => {
            const attempt = graph?.attempts.find(t => t.id === result.attempt_id)
            const assignment = graph?.assignments.find(a => a.id === attempt?.assignment_id)
            let operation: string | undefined
            let summaryContext: SummaryContext | undefined
            try {
              const input = JSON.parse(assignment?.input ?? '{}')
              operation = input.operation
              summaryContext = { goals: input.goals, plan: input.plan }
            } catch { /* Older snapshots may lack context. */ }
            const summary = summarizeResult(context.role, result.parsed ?? result.raw, operation, summaryContext)
            return summary ? (
              <div className="space-y-1 text-sm" data-graph-summary>
                <p>{summary.headline}</p>
                <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
                  {summary.rows.map((row, i) => (
                    <div key={i} className="contents">
                      <dt className="text-muted-foreground whitespace-pre">{row.label}</dt>
                      <dd className="break-words">{row.value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-xs text-muted-foreground">{summary.consequence}</p>
              </div>
            ) : null
          })()}
          <details>
            <summary className="text-xs cursor-pointer">Exact result to review (raw)</summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs mt-2">
              {result.parsed ?? result.raw}
            </pre>
          </details>
          {context.can_manage ? (
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => review(result, 'accept')}>
                Accept result
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => review(result, 'reject')}>
                Reject result
              </Button>
            </div>
          ) : (
            <p className="text-xs">An owner or maintainer must review this result.</p>
          )}
        </article>
      ))}
      {notice && !error && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}

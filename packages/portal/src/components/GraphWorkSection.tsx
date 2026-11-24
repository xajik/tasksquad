import { needsOwner } from '@/lib/graphStatus'
import { Link } from 'react-router-dom'
import {
  latestGraphAttempt,
  type GraphSnapshot,
  type GraphAssignment
} from '@/lib/graph'
import { Button } from '@/components/ui/button'
import { GraphSection } from '@/components/GraphSection'
import { type GraphView } from '@/lib/graphDashboard'

import { workRank, pretty, stamp } from '@/lib/graphWork'

export interface Confirming {
  title: string
  description: string
  confirm: string
  run: () => Promise<unknown> | void
}

/** The owner's work queue (reviews, replies, recovery actions) or the graph's activity log. */
export function GraphWorkSection({
  current,
  view,
  isMaintainer,
  busy,
  blocked,
  now,
  range,
  command,
  setConfirming
}: {
  current: GraphSnapshot
  view: GraphView
  isMaintainer: boolean
  busy: boolean
  blocked: GraphAssignment[]
  now: number
  range: number
  command: (action: string, data?: unknown) => Promise<boolean>
  setConfirming: (c: Confirming) => void
}) {
  const tab = view === 'activity' ? 'activity' : 'next'
  const liveWeight = (a: GraphAssignment) =>
    current.scheduler?.candidates.find((c) => c.assignment_id === a.id)?.weight ?? a.priority
  return (
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
                  {needsOwner(current.waiting?.[a.id]?.action) && (
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
  )
}

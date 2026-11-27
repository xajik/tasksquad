import { verifyGoal } from './contracts.js'
import { type Graph, type Assignment, type Data, sql, rows, configuration } from './store.js'
import { dispatchContext, eligibility } from './eligibility.js'
import { candidateWeights } from './weights.js'
import { MaxHeap } from './heap.js'
import { extractApprovalRequest } from '../approval.js'

/** The interactive view needs only a few input fields (titles and links between assignments); the rest, with the role template, is fetched never. */
export function slimAssignment(a: Assignment): Data {
  const { template: _template, ...rest } = a as Assignment & { template?: string }
  let input = rest.input
  try {
    const full = JSON.parse(String(rest.input)) as Data
    const keep: Data = {}
    // `goals` and the plan's projected impact label the review summaries shown in the inbox.
    for (const k of ['proposal_id', 'execution_result_id', 'title', 'operation', 'goals'])
      if (full[k] !== undefined) keep[k] = full[k]
    const plan = full.plan as { title?: unknown; projected_impact?: unknown } | undefined
    if (plan?.title !== undefined || plan?.projected_impact !== undefined)
      keep.plan = {
        ...(plan.title !== undefined && { title: plan.title }),
        ...(plan.projected_impact !== undefined && { projected_impact: plan.projected_impact })
      }
    input = JSON.stringify(keep)
  } catch {
    /* keep the original text when it is not JSON */
  }
  return { ...rest, input }
}

/** Why a step is blocked when the agent asked for nothing: its own report, else the validation error. */
function blockedReason(result: Data | undefined, status: string): string {
  let reported = ''
  try {
    const p = JSON.parse(String(result?.parsed ?? '')) as { title?: string; description?: string }
    reported = [p.title, p.description].filter(Boolean).join(' — ')
  } catch {
    /* unparsed result */
  }
  const why = reported || String(result?.validation_error || '')
  const prefix = status === 'error' ? 'Failed' : 'Blocked'
  return `${prefix}${why ? `: ${why}` : ''}. The agent asked for no approval — fix what it is missing and reply in the inbox task to retry, or abandon the step.`
}

export async function snapshot(db: D1Database, g: Graph, enabled = true, slim = false): Promise<Data> {
  const c = await configuration(db, g)
  const [
    nodes,
    edges,
    assignments,
    attempts,
    results,
    events,
    resources,
    evidence,
    budgets,
    grading,
    evaluations,
    proposals
  ] = await Promise.all([
    rows<Data & { state_history: string }>(
      db,
      `SELECT n.*, (
         SELECT json_group_array(json_object('id',id,'state',state,'reason',reason,'created_at',created_at))
         FROM (SELECT id,state,reason,created_at FROM graph_node_states WHERE node_id=n.id ORDER BY id)
       ) AS state_history FROM graph_nodes n WHERE n.graph_id=?`,
      g.id
    ),
    rows(
      db,
      'SELECT e.*,p.baseline,p.predicates,p.steps,p.undo_steps,p.cost,p.recovery_cost,p.resource_versions,p.effects FROM graph_edges e LEFT JOIN graph_plans p ON p.edge_id=e.id WHERE e.graph_id=?',
      g.id
    ),
    rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE graph_id=? ORDER BY created_at', g.id),
    rows(
      db,
      'SELECT t.*,task.status AS task_status,task.tui_blocked FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id JOIN tasks task ON task.id=t.task_id WHERE a.graph_id=?',
      g.id
    ),
    rows(
      db,
      'SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=?',
      g.id
    ),
    rows(db, 'SELECT * FROM graph_events WHERE graph_id=? ORDER BY sequence DESC LIMIT 500', g.id),
    rows(db, 'SELECT * FROM graph_resources WHERE graph_id=?', g.id),
    rows<{ predicate: string; value: 'true' | 'false' | 'unknown'; scope: string; expires_at: number }>(
      db,
      'SELECT * FROM graph_evidence WHERE graph_id=?',
      g.id
    ),
    sql(db, 'SELECT * FROM graph_budgets WHERE graph_id=?', g.id).first(),
    rows(db, 'SELECT * FROM graph_grading WHERE graph_id=? ORDER BY sequence', g.id),
    rows(db, 'SELECT * FROM graph_evaluations WHERE graph_id=? ORDER BY id', g.id),
    rows(db, 'SELECT * FROM graph_proposals WHERE graph_id=?', g.id)
  ])
  const tags = await rows<{ node_id: string; tag: string }>(
    db,
    'SELECT * FROM graph_tags WHERE graph_id=?',
    g.id
  )
  const links = await rows(
    db,
    'SELECT l.* FROM graph_resource_links l JOIN graph_resources r ON r.id=l.resource_id WHERE r.graph_id=?',
    g.id
  )
  const context = await dispatchContext(db, g, enabled)
  const pending = assignments.filter((a) => a.status === 'pending')
  const weights = await candidateWeights(db, g, pending, context.now)
  const heap = new MaxHeap<Assignment>((a, b) =>
    weights.get(a.id)!.weight - weights.get(b.id)!.weight || b.id.localeCompare(a.id)
  )
  // Dispatch sorts candidates before insertion; preserve that exact tree layout,
  // not merely another valid heap with the same highest-priority root.
  const executionCandidates = pending
    .filter((a) => a.role === 'execute' && a.available_at <= context.now)
    .sort((a, b) => weights.get(b.id)!.weight - weights.get(a.id)!.weight || a.id.localeCompare(b.id))
  for (const a of executionCandidates) heap.push(a)
  const serialQueue = await rows(db,
    "SELECT * FROM graph_serial_queue WHERE graph_id=? AND status='pending' ORDER BY sequence", g.id)
  const blockedReviews = new Set(grading.filter((r) => r.status === 'blocked').map((r) => String(r.assignment_id)))
  const waiting: Record<string, unknown> = {}
  // Index once instead of rescanning every attempt and result per assignment, and run the
  // per-assignment eligibility queries concurrently: they dominated the response time.
  const attemptsBy = new Map<string, typeof attempts>()
  for (const t of attempts) {
    const list = attemptsBy.get(String(t.assignment_id)) ?? []
    list.push(t)
    attemptsBy.set(String(t.assignment_id), list)
  }
  const resultsBy = new Map<string, typeof results>()
  for (const r of results) {
    const list = resultsBy.get(String(r.attempt_id)) ?? []
    list.push(r)
    resultsBy.set(String(r.attempt_id), list)
  }
  const entries = await Promise.all(assignments.map(async (a) => {
    const latest = (attemptsBy.get(a.id) ?? [])
      .sort(
        (x, y) =>
          Number(y.epoch) - Number(x.epoch) ||
          Number(y.created_at) - Number(x.created_at) ||
          String(y.id).localeCompare(String(x.id))
      )[0]
    const result = (resultsBy.get(String(latest?.id)) ?? [])
      .sort((x, y) => Number(y.created_at) - Number(x.created_at))[0]
    const allowsOwnerInput = c.policy.review !== 'yolo'
    const request = allowsOwnerInput ? extractApprovalRequest(String(result?.parsed ?? result?.raw ?? '')) : null
    const canReply =
      allowsOwnerInput &&
      ['blocked', 'error'].includes(a.status) &&
      a.role !== 'repair' &&
      latest &&
      !['done', 'failed', 'cancelled'].includes(String(latest.task_status))
    const detail =
      blockedReviews.has(a.id)
        ? { code: 'review_failed', message: `Review failed after ${a.attempt_count} / ${a.max_attempts} attempts${latest?.status ? ` (last attempt: ${latest.status})` : ''}. Grading is incomplete. Independent work can continue; retry or cancel this review in the graph work queue.` }
        : a.status === 'pending'
        ? await eligibility(a, context)
        : a.status === 'review'
          ? { code: 'review', message: 'An owner or maintainer must review this result.' }
          : canReply
            ? request
              ? {
                  code: 'owner_input',
                  message: request.reason || request.title || String(result?.validation_error || 'Reply in the latest inbox task to continue.')
                }
              : {
                  // The agent stopped on its own ("blocked") without asking anything, so there is
                  // nothing to approve: surface its reason instead of a generic reply prompt.
                  code: 'blocked',
                  message: blockedReason(result, a.status)
                }
            : a.status === 'continuation'
              ? {
                  code: 'continuation',
                  message: 'Input received. Follow the continuation task for the next decision.'
                }
              : ['reconciling', 'restoring'].includes(a.status) ||
                  (a.role === 'repair' && ['pending', 'running'].includes(a.status))
                ? { code: 'recovery', message: 'Recovery in progress.' }
                : null
    return detail
      ? ([a.id, {
        code: detail.code,
        message: detail.message,
        task_id: latest?.task_id ?? null,
        action: blockedReviews.has(a.id) ? 'view' : a.status === 'review' ? 'review' : canReply ? 'reply' : latest ? 'view' : null,
        request_title: canReply ? (request?.title ?? null) : null,
        has_request: !!request
      }] as const)
      : null
  }))
  for (const entry of entries) if (entry) waiting[entry[0]] = entry[1]
  return {
    ...g,
    config: c,
    nodes: nodes.map((n) => {
      const history = JSON.parse(n.state_history) as { id: number; state: string; reason: string | null; created_at: number }[]
      const latest = history.at(-1)
      return {
        ...n,
        state_history: history,
        state: latest?.state ?? null,
        reason: latest?.reason ?? null,
        state_changed_at: latest?.created_at ?? null,
        tags: tags.filter((t) => t.node_id === n.id).map((t) => t.tag)
      }
    }),
    resource_links: links,
    edges,
    // The page never reads the role template (~10 KB per assignment), so the interactive
    // view omits it; archived snapshots keep the full row.
    assignments: slim ? assignments.map(slimAssignment) : assignments,
    attempts,
    results,
    events,
    resources,
    evidence,
    budgets,
    grading,
    evaluations,
    proposals,
    waiting,
    scheduler: {
      sampled_at: context.now,
      next_selection: (Number(context.budgets.allocations) + 1) % 5 === 0 ? 'lowest' : 'highest',
      candidates: pending.map((a) => ({ assignment_id: a.id, ...weights.get(a.id)! })),
      heap: heap.snapshot().map((a) => a.id),
      serial_queue: serialQueue,
      reservations: context.used.filter((r) => r.graph_id === g.id)
    },
    goal_verification: verifyGoal(c.rule, evidence, Date.now())
  }
}

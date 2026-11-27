import { actionLedger } from '../dedup.js'
import { isReview } from '../roles.js'
import { queueDone, queuePush } from './queue.js'
import { assignment, commit, configuration, rows, sql, type Assignment, type Data, type Graph, type Result } from '../store.js'
import { goalHierarchy } from './assertions.js'
import { syncInboxStatus } from './owner.js'
import { rejectExecutionForQuality } from './accept/execute.js'
import { resolve } from './results.js'

export async function advanceGrading(db: D1Database, g: Graph): Promise<void> {
  const serial = await sql(
    db,
    "SELECT * FROM graph_serial_queue WHERE graph_id=? AND status='pending' ORDER BY sequence LIMIT 1",
    g.id
  ).first<{ kind: string; work_id: string }>()
  if (!serial || serial.kind !== 'execution') return
  const head = await sql(
    db,
    "SELECT * FROM graph_grading WHERE graph_id=? AND execution_result_id=? AND status IN ('pending','running') ORDER BY sequence LIMIT 1",
    g.id,
    serial.work_id
  ).first<{
    sequence: number
    stage: 'grade' | 'project'
    assignment_id: string | null
    execution_result_id: string
  }>()
  if (!head || head.assignment_id) return
  const r = (await sql(
    db,
    'SELECT * FROM graph_results WHERE id=?',
    head.execution_result_id
  ).first<Result>())!
  // A validated execution remains unpublished while the initial grade decides acceptance.
  const awaitingGrade = r.status === 'received' && !!r.parsed && head.stage === 'grade'
  if (!awaitingGrade && r.status !== 'accepted') return
  const { a, original, t } = await resolve(db, r)
  const result = JSON.parse(r.parsed!) as Data
  const evidence = awaitingGrade ? result.evidence : await rows(db, 'SELECT * FROM graph_evidence WHERE source_result_id=?', r.id)
  // A repaired result has two authors. Neither may supply the deciding grade through the fallback slot.
  const authors = awaitingGrade && a.role === 'repair'
    ? await rows<{ agent_id: string }>(db, 'SELECT DISTINCT agent_id FROM graph_attempts WHERE assignment_id=? AND epoch=?', original.id, original.attempt_count)
    : []
  const context: Data = {
    execution_result_id: r.id,
    grading_sequence: head.sequence,
    result,
    ...(awaitingGrade ? { operation: 'result_acceptance', result_agent_ids: [t.agent_id, ...authors.map((row) => row.agent_id)] } : {}),
    plan: JSON.parse(original.input),
    evidence,
    attempted_actions: await actionLedger(db, g.id, undefined, original.edge_id)
  }
  if (head.stage === 'project') {
    const c = await configuration(db, g)
    context.private_goal = g.body
    context.rule = c.rule
    context.goals = await goalHierarchy(db, g, c.rule.predicates)
  }
  const next = await assignment(db, g, head.stage, context, {
    edge: original.edge_id,
    parent: original.id,
    node: original.node_id
  })
  await commit(db, g, 'grading_queued', next.id, {}, [
    ...next.statements,
    sql(
      db,
      "UPDATE graph_grading SET assignment_id=?,status='running' WHERE sequence=?",
      next.id,
      head.sequence
    )
  ])
}

/** Park an exhausted review without treating it as a passed or completed grade. Other
 * serial work can proceed, while this grading revision retains its failed assignment. */
export async function parkFailedReviews(db: D1Database, g: Graph): Promise<void> {
  const failed = await rows<{ sequence: number; assignment_id: string; execution_result_id: string }>(
    db,
    `SELECT grading.sequence,grading.assignment_id,grading.execution_result_id FROM graph_grading grading
     JOIN graph_assignments a ON a.id=grading.assignment_id
     WHERE grading.graph_id=? AND grading.status IN ('pending','running')
     AND a.role IN ('grade','project') AND a.status IN ('blocked','error')
     AND NOT EXISTS(SELECT 1 FROM graph_assignments child WHERE child.parent_id=a.id
       AND child.role IN ('repair','continue') AND child.status IN ('pending','running','review'))
     AND NOT EXISTS(SELECT 1 FROM graph_attempts t WHERE t.assignment_id=a.id AND t.status IN ('pending','running'))`,
    g.id
  )
  // Standalone reviews (e.g. decomposition reviews) own a serial-queue entry keyed by their own assignment id
  // and have no grading row. Once exhausted they must release the queue head as well.
  await sql(
    db,
    `UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND kind='assignment' AND status='pending'
     AND work_id IN (SELECT a.id FROM graph_assignments a WHERE a.graph_id=? AND a.role IN ('grade','project')
       AND a.status IN ('blocked','error') AND a.attempt_count>=a.max_attempts
       AND NOT EXISTS(SELECT 1 FROM graph_grading gr WHERE gr.assignment_id=a.id)
       AND NOT EXISTS(SELECT 1 FROM graph_assignments child WHERE child.parent_id=a.id
         AND child.role IN ('repair','continue') AND child.status IN ('pending','running','review'))
       AND NOT EXISTS(SELECT 1 FROM graph_attempts t WHERE t.assignment_id=a.id AND t.status IN ('pending','running')))`,
    g.id,
    g.id
  ).run()
  for (const review of failed)
    await commit(db, g, 'review_blocked', review.assignment_id, { grading_sequence: review.sequence }, [
      sql(db, "UPDATE graph_grading SET status='blocked' WHERE sequence=?", review.sequence),
      queueDone(db, g.id, 'execution', review.execution_result_id)
    ])
}

/** Read-only reviews are safe to retry; never reset old attempts or replay execution. */
export async function recoverReview(db: D1Database, g: Graph, assignmentId: string, retry: boolean, userId?: string): Promise<void> {
  const a = await sql(db, 'SELECT * FROM graph_assignments WHERE id=? AND graph_id=?', assignmentId, g.id).first<Assignment>()
  if (a?.status === 'cancelled' && ['review_retried', 'review_cancelled'].includes(a.cancel_reason ?? '')) return
  if (!a || !isReview(a.role) || !['blocked','error'].includes(a.status))
    throw new Error('A blocked or failed execution review is required')
  const review = await sql(db,
    "SELECT sequence,execution_result_id FROM graph_grading WHERE graph_id=? AND assignment_id=? AND status IN ('pending','running','blocked')",
    g.id, a.id
  ).first<{ sequence: number; execution_result_id: string }>()
  const standalone = review
    ? null
    : await sql(db,
        "SELECT 1 AS x FROM graph_serial_queue WHERE graph_id=? AND kind='assignment' AND work_id=?", g.id, a.id
      ).first()
  if (!review && !standalone) throw new Error('This step no longer owns an unfinished execution review')
  const active = await sql(db,
    `SELECT 1 FROM graph_attempts t JOIN graph_assignments x ON x.id=t.assignment_id
     WHERE t.status IN ('pending','running') AND (x.id=? OR x.parent_id=?)
     UNION ALL SELECT 1 FROM graph_assignments WHERE parent_id=? AND status IN ('pending','running','review') LIMIT 1`,
    a.id, a.id, a.id
  ).first()
  if (active) throw new Error('Wait for the review and its recovery work to stop')
  const next = retry ? await assignment(db, g, a.role, JSON.parse(a.input), {
    node: a.node_id, edge: a.edge_id, parent: a.id, priority: a.priority
  }) : null
  const ops = [
    ...(next?.statements ?? []),
    sql(db, "UPDATE graph_assignments SET status='cancelled',cancel_reason=? WHERE id=?", retry ? 'review_retried' : 'review_cancelled', a.id),
    ...(review ? [
      sql(db, 'UPDATE graph_grading SET assignment_id=?,status=? WHERE sequence=?', next?.id ?? a.id, retry ? 'running' : 'cancelled', review.sequence),
      queueDone(db, g.id, 'execution', review.execution_result_id)
    ] : [
      queueDone(db, g.id, 'assignment', a.id)
    ])
  ]
  if (next) ops.push(review
    ? queuePush(db, g.id, 'execution', review.execution_result_id)
    : queuePush(db, g.id, 'assignment', next.id))
  if (!retry && review && JSON.parse(a.input).operation === 'result_acceptance') {
    const execution = await sql(db, "SELECT * FROM graph_results WHERE id=? AND status='received'", review.execution_result_id).first<Result>()
    if (execution) ops.push(...await rejectExecutionForQuality(db, g, execution, 'Quality review was cancelled without a score.'))
  }
  await commit(db, g, retry ? 'review_retried' : 'review_cancelled', a.id,
    { retry: next?.id ?? null, grading_sequence: review?.sequence ?? null, user_id: userId ?? null, grading_verified: false }, ops)
  await syncInboxStatus(db, g)
}

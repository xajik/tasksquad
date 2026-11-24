import { isPlanning } from '../roles.js'
import { assignment, commit, rows, sql, type Assignment, type Data, type Graph } from '../store.js'


/** Queue ownership survives format repairs and checked continuations, including review. */
export const ACTIVE_CONTINUE_WORK = `SELECT json_extract(input,'$.serial_work_id') FROM graph_assignments
  WHERE graph_id=? AND role='continue' AND status IN ('pending','running','review') AND json_extract(input,'$.serial_work_id') IS NOT NULL`

export const ACTIVE_REPAIR_WORK = `SELECT CASE WHEN original.role IN ('grade','project','continue')
  THEN COALESCE(json_extract(original.input,'$.serial_work_id'),json_extract(original.input,'$.execution_result_id'),original.id)
  ELSE r.id END FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id
  JOIN graph_assignments original ON original.id=t.assignment_id
  JOIN graph_assignments repair ON repair.parent_id=t.assignment_id
  WHERE repair.graph_id=? AND repair.role='repair' AND repair.status IN ('pending','running','review')
  AND r.status='invalid' AND t.epoch=(SELECT MAX(epoch) FROM graph_attempts WHERE assignment_id=t.assignment_id)`

/** Planning steps are side-effect free, so a blocked/errored one the owner closes by hand is treated as
 * failed: cancel it (and any open repair) and queue a fresh copy. Execution, review and recovery steps
 * are never retried this way — repeating them could repeat a side effect. */
export async function failAssignment(db: D1Database, g: Graph, assignmentId: string): Promise<void> {
  const a = await sql(
    db,
    "SELECT * FROM graph_assignments WHERE id=? AND graph_id=? AND status IN ('blocked','error')",
    assignmentId,
    g.id
  ).first<Assignment>()
  if (!a || !isPlanning(a.role)) return
  const next = await assignment(db, g, a.role, JSON.parse(a.input), {
    node: a.node_id,
    edge: a.edge_id,
    parent: a.parent_id,
    priority: a.priority
  })
  await commit(db, g, 'assignment_failed', a.id, { retry: next.id }, [
    sql(
      db,
      `UPDATE graph_assignments SET status='cancelled',cancel_reason='closed'
       WHERE graph_id=? AND (id=? OR (parent_id=? AND role='repair' AND status IN ('pending','running','review','blocked','error')))`,
      g.id,
      a.id,
      a.id
    ),
    ...next.statements
  ])
}

/** The owner's way out of a step that cannot be resolved (an agent that cannot produce the attestations a
 * continuation needs, an `unknown` reconcile, an answer the step cannot use). Unlike `fail`, nothing is retried:
 * repeating an execution, undo or reconcile could repeat a side effect. The step, its continuations and repairs are
 * cancelled, its queue entries and reservations are released, and its node is deactivated so dispatch moves on to
 * other candidates and the revival planner can propose alternatives. Whatever the agent may have left behind stays
 * unverified; the event records that so the decision is auditable. */
export async function abandonAssignment(
  db: D1Database,
  g: Graph,
  assignmentId: string,
  userId?: string
): Promise<void> {
  const a = await sql(
    db,
    "SELECT * FROM graph_assignments WHERE id=? AND graph_id=? AND status IN ('blocked','error')",
    assignmentId,
    g.id
  ).first<Assignment>()
  if (!a) throw new Error('A blocked assignment is required')
  if (a.role === 'repair') throw new Error('Abandon the original assignment, not its repair')
  // Walk to the original step and collect the whole continuation lineage.
  const lineage: Assignment[] = [a]
  const seen = new Set<string>([a.id])
  for (let cur = a; cur.parent_id && ['continue', 'reconcile', 'undo'].includes(cur.role); ) {
    const parent = await sql(
      db,
      'SELECT * FROM graph_assignments WHERE id=? AND graph_id=?',
      cur.parent_id,
      g.id
    ).first<Assignment>()
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    lineage.push(parent)
    cur = parent
  }
  const ids = lineage.map((x) => x.id),
    marks = ids.map(() => '?').join(','),
    root = lineage[lineage.length - 1]
  const active = await sql(
    db,
    `SELECT 1 FROM graph_attempts t JOIN graph_assignments x ON x.id=t.assignment_id
     WHERE t.status IN ('pending','running') AND (x.id IN (${marks}) OR x.parent_id IN (${marks})) LIMIT 1`,
    ...ids,
    ...ids
  ).first()
  if (active) throw new Error('A step in this chain is still running; wait for it to stop before abandoning')
  const workIds = [
    ...new Set(
      lineage.flatMap((x) => {
        const input = JSON.parse(x.input) as Data
        return [input.serial_work_id, input.execution_result_id, x.id].filter((v): v is string => typeof v === 'string')
      })
    )
  ]
  const resultWork = `SELECT r.id FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.assignment_id IN (${marks})`
  const workMarks = workIds.map(() => '?').join(',')
  const now = Date.now()
  const ops: D1PreparedStatement[] = [
    sql(
      db,
      `UPDATE graph_assignments SET status='cancelled',cancel_reason='abandoned'
       WHERE graph_id=? AND status IN ('pending','running','review','blocked','error','continuation','reconciling')
       AND (id IN (${marks}) OR (role='repair' AND parent_id IN (${marks})))`,
      g.id,
      ...ids,
      ...ids
    ),
    sql(
      db,
      `DELETE FROM graph_reservations WHERE attempt_id IN (SELECT id FROM graph_attempts WHERE assignment_id IN (${marks}))`,
      ...ids
    ),
    sql(
      db,
      `UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND status='pending'
       AND (work_id IN (${workMarks}) OR work_id IN (${resultWork}))`,
      g.id,
      ...workIds,
      ...ids
    ),
    sql(
      db,
      `UPDATE graph_grading SET status='done' WHERE graph_id=? AND status!='done' AND execution_result_id IN (${workMarks})`,
      g.id,
      ...workIds
    )
  ]
  if (root.node_id)
    ops.push(
      sql(
        db,
        "INSERT INTO graph_node_states(graph_id,node_id,state,reason,created_at) VALUES(?,?,'deactivated','abandoned',?)",
        g.id,
        root.node_id,
        now
      )
    )
  await commit(
    db,
    g,
    'assignment_abandoned',
    a.id,
    { role: root.role, original: root.id, cancelled: ids, side_effects_verified: false, user_id: userId ?? null },
    ops
  )
  await syncInboxStatus(db, g)
}

export async function dismissStale(db: D1Database, g: Graph): Promise<number> {
  const stale = await rows<{ id: string }>(
    db,
    `SELECT a.id FROM graph_assignments a WHERE a.graph_id=? AND a.status IN ('blocked','error')
     AND a.role NOT IN ('execute','undo','reconcile','continue')
     AND (a.role='repair' OR EXISTS(SELECT 1 FROM graph_attempts t JOIN graph_results r ON r.attempt_id=t.id
          WHERE t.assignment_id=a.id AND r.status='stale'))`,
    g.id
  )
  const ops: D1PreparedStatement[] = []
  if (stale.length)
    ops.push(
      sql(
        db,
        `UPDATE graph_assignments SET status='cancelled',cancel_reason='dismissed' WHERE graph_id=? AND id IN (${stale.map(() => '?').join(',')})`,
        g.id,
        ...stale.map((a) => a.id)
      )
    )
  // Park blocked/error continuations without retrying them. A live formatting
  // repair still owns the same serial work until its result is resolved.
  // Inspect queue transitions even when there is no assignment noise to dismiss.
  const release = await rows<{ sequence: number }>(
    db,
    `SELECT q.sequence FROM graph_serial_queue q WHERE q.graph_id=? AND q.status='pending'
     AND q.work_id NOT IN (${ACTIVE_CONTINUE_WORK}) AND q.work_id NOT IN (${ACTIVE_REPAIR_WORK}) AND (
       (q.kind='assignment' AND q.work_id IN (SELECT id FROM graph_assignments WHERE graph_id=?
         AND (status IN ('cancelled','expired','accepted','continuation') OR (role='continue' AND status IN ('blocked','error')))))
       OR (q.kind='execution' AND q.work_id IN (SELECT id FROM graph_results WHERE status IN ('stale','invalid','rejected')
         OR (status='accepted' AND json_extract(parsed,'$.outcome')='blocked'))))`,
    g.id,
    g.id,
    g.id,
    g.id
  )
  const reopen = await rows<{ sequence: number }>(
    db,
    `SELECT sequence FROM graph_serial_queue WHERE graph_id=? AND status='done'
     AND (work_id IN (${ACTIVE_CONTINUE_WORK}) OR work_id IN (${ACTIVE_REPAIR_WORK}))
     AND sequence=(SELECT MAX(q.sequence) FROM graph_serial_queue q WHERE q.graph_id=graph_serial_queue.graph_id
       AND q.kind=graph_serial_queue.kind AND q.work_id=graph_serial_queue.work_id)`,
    g.id,
    g.id,
    g.id
  )
  for (const [items, status] of [
    [release, 'done'],
    [reopen, 'pending']
  ] as const)
    for (const q of items)
      ops.push(sql(db, 'UPDATE graph_serial_queue SET status=? WHERE sequence=?', status, q.sequence))
  // Newly cancelled assignment entries are included in the same durable transition.
  if (stale.length)
    ops.push(
      sql(
        db,
        "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND kind='assignment' AND work_id IN (SELECT id FROM graph_assignments WHERE graph_id=? AND status='cancelled')",
        g.id,
        g.id
      )
    )
  if (ops.length)
    await commit(
      db,
      g,
      'queue_reconciled',
      null,
      { dismissed: stale.length, released: release.length, reopened: reopen.length },
      ops
    )
  return stale.length
}

/** Inbox tasks of steps that wait for the owner stay in `waiting_input` (pending input) instead of `done`;
 * they return to `done` once the step is answered, cancelled or otherwise no longer needs the owner.
 * Planning/review steps whose result merely went out of date are noise, not owner input, and stay done. */
export async function syncInboxStatus(db: D1Database, g: Graph): Promise<void> {
  // A closed graph can no longer be answered, so its inbox tasks never return to waiting for input.
  if (g.status === 'stopped') {
    await sql(
      db,
      `UPDATE tasks SET status='done' WHERE status='waiting_input'
       AND id IN (SELECT t.task_id FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=?)`,
      g.id
    ).run()
    return
  }
  const needsOwner = `SELECT t.task_id FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id
    WHERE a.graph_id=? AND a.status IN ('blocked','error') AND a.role!='repair'
    AND NOT EXISTS(SELECT 1 FROM graph_grading grading WHERE grading.assignment_id=a.id AND grading.status='blocked')
    AND NOT EXISTS(SELECT 1 FROM graph_assignments repair WHERE repair.parent_id=a.id AND repair.role='repair' AND repair.status IN ('pending','running','review'))
    AND t.epoch=(SELECT MAX(epoch) FROM graph_attempts WHERE assignment_id=a.id)
    AND (a.role IN ('execute','undo','continue') OR NOT EXISTS(
      SELECT 1 FROM graph_results r WHERE r.attempt_id=t.id AND r.status='stale'))`
  await db.batch([
    sql(db, `UPDATE tasks SET status='waiting_input' WHERE status IN ('done','failed') AND id IN (${needsOwner})`, g.id),
    sql(
      db,
      `UPDATE tasks SET status='done' WHERE status='waiting_input'
       AND id IN (SELECT t.task_id FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=?)
       AND id NOT IN (${needsOwner})`,
      g.id,
      g.id
    ),
    sql(db, `UPDATE tasks SET status='failed' WHERE status IN ('waiting_input','done') AND id IN (
      SELECT t.task_id FROM graph_attempts t JOIN graph_grading grading ON grading.assignment_id=t.assignment_id
      WHERE grading.graph_id=? AND grading.status='blocked'
      AND t.epoch=(SELECT MAX(epoch) FROM graph_attempts WHERE assignment_id=t.assignment_id))`, g.id)
  ])
}

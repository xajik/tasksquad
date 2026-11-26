import { nodeStatements, releaseRecovery, sql, json, type Data, type Graph, type Result } from '../../store.js'
import { executionResources } from '../shared.js'

import { resolve } from '../results.js'
import { evidenceStatements } from '../accept.js'
import type { AcceptCtx } from './context.js'

// Intake reserved a serial grading slot for the original execution attempt.
export function rebindExecutionReview(db: D1Database, originalId: string, resultId: string) {
  const originalResult = `SELECT r.id FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id
    WHERE t.assignment_id=? ORDER BY t.epoch DESC LIMIT 1`
  return [
    sql(db, `UPDATE graph_serial_queue SET work_id=? WHERE kind='execution' AND work_id=(${originalResult})`, resultId, originalId),
    sql(db, `UPDATE graph_grading SET execution_result_id=? WHERE execution_result_id=(${originalResult})`, resultId, originalId)
  ]
}

export async function rejectExecutionForQuality(db: D1Database, g: Graph, r: Result, reason: string) {
  const { a, original } = await resolve(db, r)
  return [
    sql(db, "UPDATE graph_results SET status='rejected',validation_error=? WHERE id=?", reason, r.id),
    sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id IN (?,?)", a.id, original.id),
    sql(db, 'INSERT INTO graph_events(graph_id,kind,entity_id,data,created_at) VALUES(?,?,?,?,?)',
      g.id, 'rejected', r.id, json({ role: 'execute', reason }), Date.now())
  ]
}

export async function acceptExecute(x: AcceptCtx, storedIds?: Map<string, string>): Promise<void> {
  const { db, g, r, a, original, d, input, ops, enqueue } = x
  const n = nodeStatements(db, g, 'outcome', d, r.id, original.node_id)
  ops.push(...n.statements, ...(await evidenceStatements(db, g, r, n.id, d.evidence as Data[], storedIds)))
  if (a.role === 'repair' && x.c.policy.review !== 'quality_50')
    ops.push(...rebindExecutionReview(db, original.id, r.id))
  if (d.outcome === 'complete' || d.outcome === 'blocked')
    ops.push(
      releaseRecovery(db, g.id, Number((input.plan as Data).recovery_cost))
    )
  if (d.outcome === 'blocked')
    ops.push(sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", original.id))
  if (d.outcome === 'failed') {
    ops.push(sql(db, "UPDATE graph_assignments SET status='restoring' WHERE id=?", original.id))
    await enqueue(
      'undo',
      { plan: input.plan, failed_outcome: d, resources: await executionResources(db, g.id) },
      { node: n.id, edge: original.edge_id }
    )
  }
}

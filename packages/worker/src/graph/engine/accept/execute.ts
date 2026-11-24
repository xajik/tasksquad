import { nodeStatements, releaseRecovery, sql, type Data } from '../../store.js'
import { executionResources } from '../shared.js'

import { evidenceStatements } from '../accept.js'
import type { AcceptCtx } from './context.js'

export async function acceptExecute(x: AcceptCtx): Promise<void> {
  const { db, g, r, a, original, d, input, ops, enqueue } = x
  const n = nodeStatements(db, g, 'outcome', d, r.id, original.node_id)
  ops.push(...n.statements, ...(await evidenceStatements(db, g, r, n.id, d.evidence as Data[])))
  if (a.role === 'repair')
    ops.push(
      sql(
        db,
        `UPDATE graph_serial_queue SET work_id=? WHERE kind='execution' AND work_id IN (SELECT r.id FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.assignment_id=?)`,
        r.id,
        original.id
      )
    )
  if (a.role === 'repair')
    ops.push(
      sql(
        db,
        `UPDATE graph_grading SET execution_result_id=? WHERE execution_result_id IN (SELECT r.id FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.assignment_id=?)`,
        r.id,
        original.id
      )
    )
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

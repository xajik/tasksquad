import { releaseRecovery, sql, type Assignment, type Data } from '../../store.js'
import { predicateVerified } from '../assertions.js'
import { executionResources, retryDelay } from '../shared.js'

import { evidenceStatements } from '../accept.js'
import type { AcceptCtx } from './context.js'

export async function acceptReconcile(x: AcceptCtx): Promise<void> {
  const { db, g, r, original, d, input, ops, enqueue } = x
  const prior = await sql(
    db,
    'SELECT * FROM graph_assignments WHERE id=?',
    original.parent_id
  ).first<Assignment>()
  if (!prior) throw new Error('Missing interrupted assignment')
  if (d.decision === 'unknown') {
    ops.push(sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", original.id))
    return
  }
  const interrupted = await sql(
    db,
    'SELECT id FROM graph_attempts WHERE id=? AND assignment_id=? AND termination_confirmed_at IS NOT NULL',
    input.interrupted_attempt,
    prior.id
  ).first()
  if (!interrupted) throw new Error('Wait for daemon termination acknowledgement')
  const evidence = d.evidence as Data[]
  if (d.decision === 'terminated_restored') {
    const plan = JSON.parse(prior.input).plan as Data
    const predicates = plan.restoration_predicates as string[]
    if (
      !predicates.length ||
      !predicates.every((p) => predicateVerified(evidence, p))
    )
      throw new Error('Restoration predicates are not verified')
  }
  if (prior.node_id) ops.push(...(await evidenceStatements(db, g, r, prior.node_id, evidence)))
  ops.push(
    sql(
      db,
      'DELETE FROM graph_reservations WHERE attempt_id IN (SELECT id FROM graph_attempts WHERE assignment_id=?)',
      prior.id
    )
  )
  if (d.decision === 'terminated_restored' && prior.role === 'execute')
    ops.push(
      releaseRecovery(db, g.id, Number(JSON.parse(prior.input).plan.recovery_cost))
    )
  if (d.decision === 'terminated_needs_undo')
    await enqueue(
      'undo',
      { plan: JSON.parse(prior.input).plan, resources: await executionResources(db, g.id) },
      { parent: prior.id, node: prior.node_id, edge: prior.edge_id }
    )
  else
    ops.push(
      sql(
        db,
        'UPDATE graph_assignments SET status=?,available_at=? WHERE id=?',
        prior.attempt_count < prior.max_attempts && g.status === 'running' ? 'pending' : 'error',
        Date.now() + retryDelay(prior.attempt_count),
        prior.id
      )
    )
}

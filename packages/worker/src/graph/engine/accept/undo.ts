import { nodeStatements, releaseRecovery, sql, type Assignment, type Data } from '../../store.js'
import { predicateVerified } from '../assertions.js'
import { retryDelay } from '../shared.js'

import { evidenceStatements } from '../accept.js'
import type { AcceptCtx } from './context.js'

export async function acceptUndo(x: AcceptCtx): Promise<void> {
  const { db, g, r, original, d, input, ops } = x
  const n = nodeStatements(db, g, 'restoration', d, r.id, original.node_id)
  ops.push(...n.statements, ...(await evidenceStatements(db, g, r, n.id, d.evidence as Data[])))
  const predicates = ((input.plan as Data).restoration_predicates ?? []) as string[]
  const observed = d.evidence as Data[]
  const verified =
    d.restored === true &&
    predicates.length > 0 &&
    predicates.every((p) => predicateVerified(observed, p))
  ops.push(
    sql(
      db,
      'UPDATE graph_assignments SET status=? WHERE id=?',
      verified ? 'restored' : 'blocked',
      original.parent_id
    )
  )
  if (!verified)
    ops.push(sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", original.id))
  if (verified) {
    ops.push(
      releaseRecovery(db, g.id, Number((input.plan as Data).recovery_cost))
    )
    const parent = await sql(
      db,
      'SELECT * FROM graph_assignments WHERE id=?',
      original.parent_id
    ).first<Assignment>()
    if (parent && parent.attempt_count < parent.max_attempts && g.status === 'running')
      ops.push(
        sql(
          db,
          "UPDATE graph_assignments SET status='pending',available_at=? WHERE id=?",
          Date.now() + retryDelay(parent.attempt_count),
          parent.id
        )
      )
  }
}

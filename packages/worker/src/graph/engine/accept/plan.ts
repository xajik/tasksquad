import { id, json, sql, type Data } from '../../store.js'
import { executionNodes } from '../shared.js'

import type { AcceptCtx } from './context.js'

export async function acceptPlan(x: AcceptCtx): Promise<void> {
  const { db, g, r, original, d, ops, enqueue } = x
  for (const action of d.actions as Data[]) {
    if (
      !(await sql(
        db,
        "SELECT n.id FROM graph_nodes n WHERE n.id=? AND n.graph_id=? AND (n.kind='observed' OR EXISTS(SELECT 1 FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE r.id=n.source_result_id AND r.status='accepted' AND a.role IN ('execute','undo'))) AND (SELECT state FROM graph_node_states WHERE node_id=n.id ORDER BY id DESC LIMIT 1)='active'",
        action.from_id,
        g.id
      ).first())
    )
      throw new Error('Action source outside permitted graph')
    if (
      !(action.steps as unknown[]).length ||
      !(action.undo_steps as unknown[]).length ||
      !(action.restoration_predicates as unknown[]).length ||
      !action.baseline
    )
      throw new Error('Action needs a complete restoration contract')
    for (const resource of action.resource_versions as string[])
      if (
        !(await sql(
          db,
          "SELECT id FROM graph_resources WHERE id=? AND graph_id=? AND visibility='execution'",
          resource,
          g.id
        ).first())
      )
        throw new Error('Plan references unavailable resources')
    const proposalId = id()
    ops.push(
      sql(
        db,
        'INSERT INTO graph_proposals(id,graph_id,source_result_id,content,created_at) VALUES(?,?,?,?,?)',
        proposalId,
        g.id,
        r.id,
        json(action),
        Date.now()
      )
    )
    await enqueue(
      'merge',
      { proposal_id: proposalId, action, existing_states: await executionNodes(db, g.id) },
      { node: original.node_id }
    )
  }
}

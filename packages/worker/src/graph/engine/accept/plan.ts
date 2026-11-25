import { id, json, sql, type Data } from '../../store.js'
import { actionLedger, findDuplicate, MAX_OPEN_PROPOSALS_PER_STATE, nearDuplicates, openProposals } from '../../dedup.js'
import { executionNodes } from '../shared.js'

import type { AcceptCtx } from './context.js'

export async function acceptPlan(x: AcceptCtx): Promise<void> {
  const { db, g, r, original, d, ops, enqueue, semantic } = x
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
    // Dedup before spending a reviewer: an action that restates one already tried is dropped (recorded as
    // rejected), and a state with enough open proposals takes no more until they resolve.
    const proposalId = id()
    const duplicateOf = await findDuplicate(db, g, action, semantic)
    if (duplicateOf || (await openProposals(db, g.id, String(action.from_id))) >= MAX_OPEN_PROPOSALS_PER_STATE) {
      ops.push(
        sql(
          db,
          "INSERT INTO graph_proposals(id,graph_id,source_result_id,content,status,created_at) VALUES(?,?,?,?,'rejected',?)",
          proposalId,
          g.id,
          r.id,
          json({ ...action, duplicate_of: duplicateOf }),
          Date.now()
        )
      )
      continue
    }
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
      {
        proposal_id: proposalId,
        action,
        existing_states: await executionNodes(db, g.id),
        existing_actions: await actionLedger(db, g.id),
        near_duplicates: await nearDuplicates(db, g, action, semantic)
      },
      { node: original.node_id }
    )
  }
}

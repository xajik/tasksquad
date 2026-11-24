import { id, json, nodeStatements, sql, type Data } from '../../store.js'
import { fingerprint, findDuplicate, similarMilestone, AUTO_DUPLICATE } from '../../dedup.js'
import { executionResources, planContext } from '../shared.js'

import type { AcceptCtx } from './context.js'

export async function acceptMerge(x: AcceptCtx): Promise<void> {
  const { db, g, r, d, input, ops, enqueue } = x
  const p = await sql(
    db,
    'SELECT * FROM graph_proposals WHERE id=? AND graph_id=?',
    input.proposal_id,
    g.id
  ).first<{ id: string; content: string; status: string }>()
  if (!p || p.status !== 'pending') throw new Error('Proposal no longer pending')
  if (d.decision === 'uncertain' || d.decision === 'reject') {
    ops.push(
      sql(
        db,
        'UPDATE graph_proposals SET status=? WHERE id=?',
        d.decision === 'reject' ? 'rejected' : 'uncertain',
        p.id
      )
    )
    return
  }
  if (input.direction === 'backward') {
    const candidate = JSON.parse(p.content) as Data
    if (candidate.kind === 'retire') {
      ops.push(
        sql(
          db,
          "INSERT INTO graph_node_states(graph_id,node_id,state,reason,created_at) VALUES(?,?,'deactivated','obsolete',?)",
          g.id,
          candidate.node_id,
          Date.now()
        ),
        sql(
          db,
          "UPDATE graph_assignments SET status='cancelled' WHERE graph_id=? AND node_id=? AND status='pending'",
          g.id,
          candidate.node_id
        )
      )
    } else {
      // Wording changes between decompositions; a near-identical sibling under the same parent is the same milestone.
      const similar = await similarMilestone(db, g.id, candidate)
      const existing = similar[0]?.similarity >= AUTO_DUPLICATE ? { id: similar[0].id } : null
      // Like the forward case, the reviewer judges semantic equivalence; require only that it
      // names a real milestone in this graph (exact text match would never hold for a rewording).
      const equivalent =
        d.decision === 'equivalent'
          ? await sql(
              db,
              "SELECT id FROM graph_nodes WHERE id=? AND graph_id=? AND kind='milestone'",
              d.equivalent_node_id,
              g.id
            ).first<{ id: string }>()
          : null
      if (d.decision === 'equivalent' && !equivalent && existing?.id !== d.equivalent_node_id)
        throw new Error('Equivalent milestone outside graph')
      if (!existing && !equivalent) {
        const n = nodeStatements(db, g, 'milestone', candidate, r.id, String(candidate.parent_id))
        ops.push(...n.statements)
        await enqueue(
          'plan',
          {
            task: candidate,
            observed_start: g.start_state,
            ...(await planContext(db, g.id))
          },
          { node: n.id }
        )
      }
    }
    ops.push(sql(db, "UPDATE graph_proposals SET status='published' WHERE id=?", p.id))
    return
  }
  const action = JSON.parse(p.content) as Data
  if (d.decision === 'duplicate_action') {
    const named = await sql(
      db,
      'SELECT id FROM graph_edges WHERE id=? AND graph_id=?',
      d.duplicate_edge_id,
      g.id
    ).first()
    if (!named) throw new Error('Duplicate action outside graph')
    ops.push(sql(db, "UPDATE graph_proposals SET status='published' WHERE id=?", p.id))
    return
  }
  // Identity, not wording: normalized fingerprint or near-identical same-source, same-resource text.
  if (await findDuplicate(db, g.id, action)) {
    ops.push(sql(db, "UPDATE graph_proposals SET status='published' WHERE id=?", p.id))
    return
  }
  const fp = await fingerprint(action)
  let target: string
  if (d.decision === 'equivalent') {
    const match = await sql(
      db,
      "SELECT * FROM graph_nodes WHERE id=? AND graph_id=? AND kind!='goal'",
      d.equivalent_node_id,
      g.id
    ).first<{ id: string; body: string }>()
    // Reviewer must name an existing state; action identity (fingerprint) is retained separately, so a new
    // way to reach a known state is still a distinct action.
    if (!match) throw new Error('Equivalent state outside graph')
    target = match.id
  } else {
    const n = nodeStatements(db, g, 'outcome', action, r.id)
    target = n.id
    ops.push(...n.statements)
  }
  const edge = id()
  ops.push(
    sql(
      db,
      'INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at,expected_score) VALUES(?,?,?,?,?,?,?,?,?,?)',
      edge,
      g.id,
      action.from_id,
      target,
      action.title,
      action.description,
      action.body,
      r.id,
      Date.now(),
      action.expected_quality
    ),
    sql(
      db,
      'INSERT INTO graph_plans(edge_id,baseline,predicates,steps,undo_steps,cost,recovery_cost,resource_versions,effects,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?)',
      edge,
      action.baseline,
      json(action.restoration_predicates),
      json(action.steps),
      json(action.undo_steps),
      action.cost,
      action.recovery_cost,
      json(action.resource_versions),
      json(action.effects),
      fp
    ),
    sql(db, "UPDATE graph_proposals SET status='published' WHERE id=?", p.id)
  )
  if (g.status === 'running')
    await enqueue(
      'execute',
      { plan: action, target_node: target, resources: await executionResources(db, g.id) },
      { node: target, edge }
    )
}

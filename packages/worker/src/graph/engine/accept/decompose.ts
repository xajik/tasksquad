import { similarMilestone } from '../../dedup.js'
import { id, json, rows, sql, type Data } from '../../store.js'

import type { AcceptCtx } from './context.js'

export async function acceptDecompose(x: AcceptCtx): Promise<void> {
  const { db, g, r, c, d, ops, enqueue, semantic } = x
  const parent = await sql(
    db,
    "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='goal' LIMIT 1",
    g.id
  ).first<{ id: string }>()
  const hierarchy = await rows(
    db,
    "SELECT id,title,description,body,parent_id FROM graph_nodes WHERE graph_id=? AND kind IN ('goal','milestone')",
    g.id
  )
  for (const sub of d.subgoals as Data[])
    if (Number(sub.necessity_confidence) >= c.policy.threshold) {
      const proposal = id(),
        candidate = { ...sub, kind: 'milestone', parent_id: parent?.id ?? null }
      ops.push(
        sql(
          db,
          'INSERT INTO graph_proposals(id,graph_id,source_result_id,content,created_at) VALUES(?,?,?,?,?)',
          proposal,
          g.id,
          r.id,
          json(candidate),
          Date.now()
        )
      )
      await enqueue('merge', {
        direction: 'backward',
        proposal_id: proposal,
        candidate,
        existing_hierarchy: hierarchy,
        near_duplicates: await similarMilestone(db, g, candidate, semantic)
      })
    }
  for (const node of (d.retire_ids ?? []) as string[]) {
    if (
      !(await sql(
        db,
        "SELECT id FROM graph_nodes WHERE id=? AND graph_id=? AND kind='milestone'",
        node,
        g.id
      ).first())
    )
      throw new Error('Retirement outside milestone hierarchy')
    const proposal = id(),
      candidate = { kind: 'retire', node_id: node }
    ops.push(
      sql(
        db,
        'INSERT INTO graph_proposals(id,graph_id,source_result_id,content,created_at) VALUES(?,?,?,?,?)',
        proposal,
        g.id,
        r.id,
        json(candidate),
        Date.now()
      )
    )
    await enqueue('merge', {
      direction: 'backward',
      proposal_id: proposal,
      candidate,
      existing_hierarchy: hierarchy
    })
  }
}

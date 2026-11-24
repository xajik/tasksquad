import { priority } from './priority.js'
import { rows, type Assignment, type Graph } from './store.js'

export interface CandidateWeight {
  weight: number
  local_score: number | null
  goal_score: number | null
  evidence_count: number
  observed_at: number | null
}

/** The dispatcher's current weights, using only the latest grading revisions. */
export async function candidateWeights(db: D1Database, g: Graph, pending: Assignment[], now: number) {
  const weights = new Map<string, CandidateWeight>()
  const evaluations = pending.some((a) => a.edge_id)
    ? await rows<{
        edge_id: string
        evidence_id: string
        local_score: number | null
        goal_score: number | null
        created_at: number
        role: string
      }>(db, `SELECT e.*,r.role FROM graph_evaluations e
    JOIN graph_evaluation_revisions r ON r.source_result_id=e.source_result_id
    WHERE e.graph_id=? AND NOT EXISTS(SELECT 1 FROM graph_evaluation_revisions newer
      WHERE newer.execution_result_id=r.execution_result_id AND newer.role=r.role AND newer.id>r.id)
    ORDER BY e.id`, g.id)
    : []
  const byEdge = new Map<string, typeof evaluations>()
  for (const e of evaluations) {
    const list = byEdge.get(e.edge_id)
    if (list) list.push(e)
    else byEdge.set(e.edge_id, [e])
  }
  for (const a of pending) {
    const unique = new Map<string, { local: number | null; goal: number | null; at: number }>()
    for (const e of byEdge.get(a.edge_id ?? '') ?? []) {
      const previous = unique.get(e.evidence_id) ?? { local: null, goal: null, at: e.created_at }
      unique.set(e.evidence_id, {
        local: e.role === 'grade' ? e.local_score : previous.local,
        goal: e.role === 'project' ? e.goal_score : previous.goal,
        at: e.created_at
      })
    }
    const values = [...unique.values()],
      locals = values.flatMap((e) => (e.local === null ? [] : [e.local])),
      goals = values.flatMap((e) => (e.goal === null ? [] : [e.goal]))
    const inputs = {
      local: locals.length ? locals.reduce((a, b) => a + b, 0) / locals.length : null,
      goal: goals.length ? goals.reduce((a, b) => a + b, 0) / goals.length : null,
      visits: values.length,
      observedAt: values.length ? Math.max(...values.map((e) => e.at)) : null,
      now,
      recovery: a.role === 'undo' || a.role === 'reconcile'
    }
    weights.set(a.id, {
      weight: priority(inputs),
      local_score: inputs.local,
      goal_score: inputs.goal,
      evidence_count: inputs.visits,
      observed_at: inputs.observedAt
    })
  }
  return weights
}

import { effectiveRole, type GraphSnapshot } from './graph'

const object = (text: string | null) => {
  try {
    const value = JSON.parse(text ?? 'null')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
/** Read accepted per-execution projections, never infer goal alignment from local quality. */
export function goalProjection(graph: GraphSnapshot, nodeId: string) {
  const node = graph.nodes.find((n) => n.id === nodeId)
  const outcomes = graph.results.filter(
    (r) =>
      r.status === 'accepted' &&
      ['execute', 'undo'].includes(
        effectiveRole(graph, graph.attempts.find((t) => t.id === r.attempt_id)?.assignment_id)
      )
  )
  let execution = outcomes.find((r) => r.id === node?.source_result_id)
  if (!execution) {
    const edges = new Set(graph.edges.filter((e) => e.to_id === nodeId).map((e) => e.id))
    execution = outcomes
      .filter((r) => {
        const attempt = graph.attempts.find((t) => t.id === r.attempt_id)
        const assignment = graph.assignments.find((a) => a.id === attempt?.assignment_id)
        return assignment?.node_id === nodeId || (!!assignment?.edge_id && edges.has(assignment.edge_id))
      })
      .sort(
        (a, b) =>
          (b.accepted_at ?? b.created_at) - (a.accepted_at ?? a.created_at) || b.id.localeCompare(a.id)
      )[0]
  }
  const projection = execution
    ? graph.results
        .filter((r) => {
          const assignment = graph.assignments.find(
            (a) => a.id === graph.attempts.find((t) => t.id === r.attempt_id)?.assignment_id
          )
          return (
            r.status === 'accepted' &&
            assignment?.role === 'project' &&
            object(assignment.input)?.execution_result_id === execution!.id
          )
        })
        .sort(
          (a, b) =>
            (b.accepted_at ?? b.created_at) - (a.accepted_at ?? a.created_at) || b.id.localeCompare(a.id)
        )[0]
    : undefined
  const data = projection ? object(projection.parsed) : null
  const score =
    typeof data?.goal_score === 'number' &&
    Number.isFinite(data.goal_score) &&
    data.goal_score >= 0 &&
    data.goal_score <= 1
      ? data.goal_score
      : null
  // Per-goal alignment when the projection scored each goal (root goal and milestones) separately.
  const impacts = new Map<string, number | null>()
  if (Array.isArray(data?.goal_impacts))
    for (const i of data.goal_impacts as unknown[]) {
      const row = i && typeof i === 'object' ? (i as Record<string, unknown>) : null
      if (typeof row?.goal_id !== 'string') continue
      const actual = row.actual
      impacts.set(row.goal_id, typeof actual === 'number' && Number.isFinite(actual) ? actual : null)
    }
  return {
    impacts,
    score,
    evaluated: !!projection,
    executionResultId: execution?.id ?? null,
    resultId: projection?.id ?? null,
    reason:
      typeof data?.reason === 'string'
        ? data.reason
        : 'Goal alignment has not been evaluated for this state.',
    evidenceIds: Array.isArray(data?.evidence_ids)
      ? data.evidence_ids.filter((id): id is string => typeof id === 'string')
      : []
  }
}

import { originalAssignment, type GraphNode, type GraphSnapshot } from './graph'

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
  const attempts = new Map(graph.attempts.map((a) => [a.id, a.assignment_id]))
  const assignmentOf = (r: GraphSnapshot['results'][number]) => originalAssignment(graph, attempts.get(r.attempt_id))
  const outcomes = graph.results.filter((r) =>
    r.status === 'accepted' && ['execute', 'undo'].includes(assignmentOf(r)?.role ?? '')
  )
  const edges = new Set(graph.edges.filter((e) => e.to_id === nodeId).map((e) => e.id))
  const targetsNode = (a: GraphSnapshot['assignments'][number] | undefined) =>
    a?.node_id === nodeId || (!!a?.edge_id && edges.has(a.edge_id))
  let execution = outcomes.find((r) => r.id === node?.source_result_id)
  if (!execution) {
    execution = outcomes
      .filter((r) => targetsNode(assignmentOf(r)))
      .sort(
        (a, b) =>
          (b.accepted_at ?? b.created_at) - (a.accepted_at ?? a.created_at) || b.id.localeCompare(a.id)
      )[0]
  }
  const projection = execution
    ? graph.results
        .filter((r) => {
          const assignment = assignmentOf(r)
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
  const planned = new Map<string, number>()
  // Once there is a result, compare it with the plan of that exact execution.
  const work = execution ? assignmentOf(execution) : graph.assignments.find((a) =>
    a.role === 'execute' && edges.size === 1 && a.edge_id && edges.has(a.edge_id))
  let plan = work?.role === 'execute' ? object(work.input)?.plan as { projected_impact?: unknown } | undefined : undefined
  if (!plan && !execution && edges.size === 1) {
    const source = graph.results.find((r) => r.id === node?.source_result_id)
    const merge = source && assignmentOf(source)
    const proposalId = merge?.role === 'merge' && object(merge.input)?.proposal_id
    const proposal = graph.proposals?.find((p) => p.id === proposalId)
    if (proposal) plan = object(proposal.content) ?? undefined
  }
  if (Array.isArray(plan?.projected_impact))
    for (const entry of plan.projected_impact)
      if (typeof entry?.goal_id === 'string' && typeof entry.delta === 'number' && Number.isFinite(entry.delta))
        planned.set(entry.goal_id, entry.delta)
  return {
    impacts,
    planned,
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

export function goalLinkScores(projection: ReturnType<typeof goalProjection>, goal: Pick<GraphNode, 'id' | 'kind'>) {
  const observed = projection.impacts.has(goal.id)
    ? projection.impacts.get(goal.id)
    : goal.kind === 'goal' ? projection.score : null
  return { expected: projection.planned.get(goal.id) ?? null, observed: observed ?? null }
}

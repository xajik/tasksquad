import { originalAssignment, type GraphAssignment, type GraphSnapshot } from './graph'
import { parseJson } from './parseJson'

export function rankedPlans(graph: GraphSnapshot, observations: ReadonlySet<string>) {
  const sources = new Map(
    graph.nodes
      .filter(
        (node) =>
          node.kind === 'observed' || (node.source_result_id && observations.has(node.source_result_id))
      )
      .map((node) => [node.id, node])
  )
  const executions = new Map<string, GraphAssignment>()
  // A pending run represents the next execution. Otherwise show the latest recorded run.
  const workByRecency = graph.assignments
    .filter((work) => work.role === 'execute')
    .sort(
      (a, b) =>
        Number(b.status === 'pending') - Number(a.status === 'pending') ||
        b.created_at - a.created_at ||
        b.id.localeCompare(a.id)
    )
  for (const work of workByRecency) {
    if (work.edge_id && !executions.has(work.edge_id)) executions.set(work.edge_id, work)
  }
  return graph.edges
    .flatMap((edge) => {
      const source = sources.get(edge.from_id)
      if (!source) return []
      const work = executions.get(edge.id)
      return [{ edge, source, work, pending: work?.status === 'pending' && source.state === 'active' }]
    })
    .sort(
      (a, b) =>
        (b.edge.expected_score ?? -1) - (a.edge.expected_score ?? -1) || a.edge.id.localeCompare(b.edge.id)
    )
}

export type RankedPlan = ReturnType<typeof rankedPlans>[number]

/** Read the accepted local grade for this execution, including format repairs and regrades. */
export function executionGrade(graph: GraphSnapshot, work: GraphAssignment | undefined) {
  if (!work) return
  const attempts = new Map(graph.attempts.map((attempt) => [attempt.id, attempt]))
  const executionResults = new Set(
    graph.results
      .filter(
        (result) => originalAssignment(graph, attempts.get(result.attempt_id)?.assignment_id)?.id === work.id
      )
      .map((result) => result.id)
  )
  const grades = graph.results.flatMap((result) => {
    if (result.status !== 'accepted') return []
    const attempt = attempts.get(result.attempt_id)
    const assignment = attempt && originalAssignment(graph, attempt.assignment_id)
    if (assignment?.role !== 'grade') return []
    const input = parseJson<{ execution_result_id?: string } | null>(assignment.input, null)
    return input?.execution_result_id && executionResults.has(input.execution_result_id)
      ? [{ result, agentId: attempt!.agent_id }]
      : []
  })
  const latest = grades.sort(
    (a, b) =>
      (b.result.accepted_at ?? b.result.created_at) - (a.result.accepted_at ?? a.result.created_at) ||
      b.result.id.localeCompare(a.result.id)
  )[0]
  if (!latest) return
  return {
    agentId: latest.agentId,
    ...parseJson<{ local_score?: number | null; reason?: string }>(latest.result.parsed, {})
  }
}

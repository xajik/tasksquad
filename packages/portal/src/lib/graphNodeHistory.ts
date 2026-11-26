import type { GraphNode, GraphSnapshot } from './graph'
import { parseJson } from './parseJson'

interface HistoryEntry {
  id: string
  at: number
  title: string
  detail?: string | null
  taskId?: string
  child?: GraphNode
}

export function nodeHistory(graph: GraphSnapshot, node: GraphNode): HistoryEntry[] {
  const source = graph.results.find((r) => r.id === node.source_result_id)
  const origin = source && graph.attempts.find((a) => a.id === source.attempt_id)
  const history = node.state_history ?? []
  const initial = history[0]?.created_at === node.created_at ? history[0] : undefined
  const entries: HistoryEntry[] = [{
    id: 'created', at: node.created_at, title: initial ? `Created · ${initial.state}` : 'Created',
    detail: initial?.reason, taskId: origin?.task_id
  }]
  for (const [index, state] of history.entries()) {
    if (state === initial) continue
    const previous = history[index - 1]?.state
    entries.push({
      id: `state-${state.id}`, at: state.created_at,
      title: previous ? `${previous} → ${state.state}` : state.state, detail: state.reason
    })
  }
  const work = new Map(graph.assignments.filter((a) => {
    if (a.node_id === node.id) return true
    // Reviews target the planned node, but evaluate the resulting observation.
    if (!source || (a.role !== 'grade' && a.role !== 'project')) return false
    return parseJson<{ execution_result_id?: string } | null>(a.input, null)?.execution_result_id === source.id
  }).map((a) => [a.id, a]))
  const attempts = new Map(graph.attempts.filter((a) => work.has(a.assignment_id)).map((a) => [a.id, a]))
  for (const a of work.values())
    entries.push({ id: a.id, at: a.created_at, title: `Queued · ${a.role}` })
  for (const a of attempts.values()) {
    const role = work.get(a.assignment_id)!.role
    entries.push({ id: a.id, at: a.created_at, title: `Dispatched · ${role}`, taskId: a.task_id })
    if (a.completed_at != null)
      entries.push({ id: `finished-${a.id}`, at: a.completed_at, title: `Attempt finished · ${role}`,
        detail: a.status, taskId: a.task_id })
  }
  for (const result of graph.results) {
    const attempt = attempts.get(result.attempt_id)
    if (!attempt) continue
    const role = work.get(attempt.assignment_id)!.role
    entries.push({ id: result.id, at: result.created_at, title: `Result received · ${role}`,
      detail: result.validation_error, taskId: attempt.task_id })
    if (result.accepted_at != null) {
      const data = parseJson<{ title?: string; reason?: string } | null>(result.parsed, null)
      entries.push({ id: `accepted-${result.id}`, at: result.accepted_at, title: `Result accepted · ${role}`,
        detail: data?.reason || data?.title, taskId: attempt.task_id })
    }
  }
  for (const child of graph.nodes.filter((n) => n.parent_id === node.id))
    entries.push({ id: child.id, at: child.created_at, title: 'Derived node created', child })
  return entries.sort((a, b) => a.at - b.at)
}

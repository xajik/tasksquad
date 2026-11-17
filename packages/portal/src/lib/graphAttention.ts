import type { GraphSnapshot, GraphAssignment } from './graph'
export interface GraphAttention {
  assignmentId: string
  taskId: string | null
  kind: 'reply' | 'review' | 'recovering'
  label: string
}
/** Resolve attention through assignment/attempt identity, including result nodes and repairs. */
export function graphAttention(graph: GraphSnapshot) {
  const nodes = new Map<string, GraphAttention[]>(),
    edges = new Map<string, GraphAttention[]>()
  const add = (map: Map<string, GraphAttention[]>, id: string | null | undefined, item: GraphAttention) => {
    if (id && !map.get(id)?.some((a) => a.assignmentId === item.assignmentId))
      map.set(id, [...(map.get(id) ?? []), item])
  }
  for (const a of graph.assignments) {
    const attempts = graph.attempts
      .filter((t) => t.assignment_id === a.id)
      .sort(
        (x, y) => (y.epoch ?? 0) - (x.epoch ?? 0) || y.created_at - x.created_at || y.id.localeCompare(x.id)
      )
    const latest = attempts[0]
    const waiting =
      a.status === 'running' &&
      latest?.status === 'running' &&
      (latest.task_status === 'waiting_input' || !!latest.tui_blocked)
    const kind =
      ['blocked', 'error'].includes(a.status) || waiting
        ? 'reply'
        : a.status === 'review'
          ? 'review'
          : ['reconciling', 'restoring'].includes(a.status)
            ? 'recovering'
            : null
    if (!kind) continue
    const parent = a.role === 'repair' ? graph.assignments.find((p) => p.id === a.parent_id) : null
    const replyTask =
      parent && kind === 'reply'
        ? graph.attempts
            .filter((t) => t.assignment_id === parent.id)
            .sort((x, y) => (y.epoch ?? 0) - (x.epoch ?? 0) || y.created_at - x.created_at)[0]
        : null
    const item: GraphAttention = {
      assignmentId: a.id,
      taskId: replyTask?.task_id ?? latest?.task_id ?? null,
      kind,
      label:
        kind === 'reply' ? 'Reply in inbox' : kind === 'review' ? 'Review in inbox' : 'View recovery in inbox'
    }
    let linked: GraphAssignment | undefined = a
    const seen = new Set<string>()
    while (linked && !linked.node_id && !linked.edge_id && linked.parent_id && !seen.has(linked.id)) {
      seen.add(linked.id)
      linked = graph.assignments.find((p) => p.id === linked!.parent_id)
    }
    const edge = graph.edges.find((e) => e.id === linked?.edge_id)
    add(nodes, linked?.node_id ?? edge?.to_id ?? graph.nodes.find((n) => n.kind === 'goal')?.id, item)
    add(edges, linked?.edge_id, item)
    const results = new Set(
      graph.results.filter((r) => attempts.some((t) => t.id === r.attempt_id)).map((r) => r.id)
    )
    for (const n of graph.nodes)
      if (n.source_result_id && results.has(n.source_result_id)) add(nodes, n.id, item)
  }
  return { nodes, edges }
}

import defaultPolicy from '../../../worker/src/graph/default-policy.json'
import { isActiveAttempt } from './graphStatus'
import { request } from './api'

export interface GraphPolicy {
  agents: string[]
  grader: string
  decomposer: string
  fallback: string | null
  capacity: number
  threshold: number
  review: boolean | 'quality_50'
  deadline_ms: number
  max_attempts: number
  attempt_budget: number
  cost_budget: number
  recovery_budget: number
  planning_budget: number
  ttl_ms: number
  maintenance_ms: number
  freshness_ms: number
}
export interface GraphSearchHit {
  id: string
  title: string
  description: string
  body: string
}
export interface GraphRule {
  op: 'AND' | 'OR'
  predicates: string[]
  scope: string
}
export interface GraphSummary {
  id: string
  title: string
  description: string
  body: string
  start_state: string
  status: string
  version: number
  created_at: number
}
export interface GraphNode {
  state_history?: { id: number; state: string; reason: string | null; created_at: number }[]
  state_changed_at?: number
  source_result_id?: string | null
  tags?: string[]
  id: string
  kind: string
  title: string
  description: string
  body: string
  state: string
  reason: string | null
  created_at: number
  parent_id: string | null
}
export interface GraphEdge {
  expected_score: number | null
  id: string
  from_id: string
  to_id: string
  title: string
  description: string
  body: string
  baseline: string
  predicates: string
  steps: string
  undo_steps: string
  cost: number
  recovery_cost: number
  resource_versions: string
  effects: string
}
export interface GraphAssignment {
  id: string
  role: string
  status: string
  node_id: string | null
  edge_id: string | null
  parent_id: string | null
  priority: number
  config_version: number
  attempt_count: number
  max_attempts: number
  created_at: number
  input: string
  available_at?: number
  cancel_reason?: string | null
}
export interface GraphAttempt {
  epoch?: number
  task_status?: string
  tui_blocked?: number | boolean
  id: string
  assignment_id: string
  task_id: string
  agent_id: string
  session_id: string | null
  status: string
  deadline: number
  completed_at: number | null
  created_at: number
}
export interface GraphResult {
  id: string
  attempt_id: string
  raw: string
  parsed: string | null
  validation_error: string | null
  output_hash: string
  status: string
  created_at: number
  accepted_at: number | null
}
export interface GraphResource {
  id: string
  version: number
  title: string
  description: string
  body: string
  visibility: string
}
export interface GraphEvent {
  sequence: number
  kind: string
  entity_id: string | null
  data: string
  created_at: number
}
export interface GraphEvaluation {
  id: number
  edge_id: string
  source_result_id: string
  evidence_id: string
  context: string
  local_score: number | null
  goal_score: number | null
}
export interface GraphSnapshot extends GraphSummary {
  waiting?: Record<
    string,
    {
      code: string
      message: string
      task_id: string | null
      action: 'reply' | 'review' | 'view' | null
      request_title: string | null
      has_request?: boolean
    }
  >
  proposals: { id: string; status: string; content: string; source_result_id: string }[]
  evidence: {
    node_id: string
    resource_id: string
    predicate: string
    value: string
    source_result_id: string
    observed_at?: number
    expires_at?: number
    scope?: string
  }[]
  resource_links: { node_id: string; resource_id: string }[]
  scheduler?: {
    sampled_at: number
    next_selection: 'highest' | 'lowest'
    candidates: {
      assignment_id: string
      weight: number
      local_score: number | null
      goal_score: number | null
      evidence_count: number
      observed_at: number | null
    }[]
    heap: string[]
    serial_queue: { sequence: number; kind: string; work_id: string; status: string; created_at: number }[]
    reservations: { agent_id: string; attempt_id: string; kind: string; graph_id: string }[]
  }
  config: { policy: GraphPolicy; rule: GraphRule; version: number }
  nodes: GraphNode[]
  edges: GraphEdge[]
  assignments: GraphAssignment[]
  attempts: GraphAttempt[]
  results: GraphResult[]
  resources: GraphResource[]
  events: GraphEvent[]
  evaluations: GraphEvaluation[]
  goal_verification: string
  budgets: { attempts: number; execution_cost: number; recovery_reserved: number; allocations: number }
  grading: {
    sequence: number
    stage: string
    status: string
    assignment_id: string | null
    execution_result_id: string
  }[]
}

export function latestGraphAttempt(graph: Pick<GraphSnapshot, 'attempts'>, assignmentId: string) {
  return graph.attempts
    .filter((t) => t.assignment_id === assignmentId)
    .sort(
      (a, b) => (b.epoch ?? 0) - (a.epoch ?? 0) || b.created_at - a.created_at || b.id.localeCompare(a.id)
    )[0]
}

export function graphRunExplanation(graph: GraphSnapshot): string {
  if (graph.status === 'paused')
    return 'Paused. New execution and planning wait for Run; reviews and recovery may still finish.'
  if (graph.status === 'stopped') return 'Closed. This graph cannot be resumed.'
  const active = graph.attempts.filter((a) => isActiveAttempt(a.status)).length
  if (active) return `${active} active job${active === 1 ? '' : 's'}.`
  if (graph.grading?.some((r) => r.status === 'blocked'))
    return 'Blocked: review failed. Open the work queue to retry or cancel it; grading remains incomplete.'
  const waits = Object.values(graph.waiting ?? {})
  if (waits.some((w) => w.action === 'reply' || w.action === 'review'))
    return 'Waiting for your input or review. Open the highlighted inbox task below.'
  const pending = graph.assignments.find((a) => a.status === 'pending')
  if (pending && graph.waiting?.[pending.id]) return graph.waiting[pending.id].message
  return 'No active jobs. Check the work queue and verified goal evidence.'
}
export interface NewGraph {
  title: string
  description: string
  body: string
  start_state: string
  policy: GraphPolicy
  rule: GraphRule
}
const base = (team: string) => `/teams/${encodeURIComponent(team)}/graphs`
export const graphApi = {
  list: (team: string) => request<{ graphs: GraphSummary[] }>(base(team)),
  create: (team: string, data: NewGraph) =>
    request<GraphSummary>(base(team), { method: 'POST', body: JSON.stringify(data) }),
  clone: (team: string, graph: string, withNodes: boolean) =>
    request<GraphSummary>(`${base(team)}/${graph}/clone`, {
      method: 'POST',
      body: JSON.stringify({ with_nodes: withNodes })
    }),
  get: (team: string, graph: string) => request<GraphSnapshot>(`${base(team)}/${graph}`),
  command: (team: string, graph: string, action: string, body: unknown = {}) =>
    request<{ ok: boolean }>(`${base(team)}/${graph}/${action}`, {
      method: 'POST',
      body: JSON.stringify(body)
    }),
  search: (team: string, graph: string, q: string) =>
    request<{ nodes: GraphSearchHit[]; resources: GraphResource[]; edges: GraphSearchHit[] }>(
      `${base(team)}/${graph}/search?q=${encodeURIComponent(q)}`
    )
}
/** Shared with the worker (`policy()` defaults), so the create form and the server cannot drift. */
export const defaultGraphPolicy: GraphPolicy = { ...(defaultPolicy as GraphPolicy), agents: [] }

/** A format-repair assignment stands in for its parent role: its accepted result IS the parent's result. */
export function originalAssignment(
  graph: Pick<GraphSnapshot, 'assignments'>,
  assignmentId: string | undefined
) {
  let a = graph.assignments.find((x) => x.id === assignmentId)
  for (let guard = 0; a && a.role === 'repair' && a.parent_id && guard < 4; guard++)
    a = graph.assignments.find((x) => x.id === a!.parent_id)
  return a
}

export function effectiveRole(graph: Pick<GraphSnapshot, 'assignments'>, assignmentId: string | undefined) {
  return originalAssignment(graph, assignmentId)?.role ?? ''
}

export function observedResultIds(graph: GraphSnapshot) {
  const attempts = new Map(graph.attempts.map((t) => [t.id, t.assignment_id]))
  return new Set(graph.results.filter((r) => r.status === 'accepted' &&
    ['execute', 'undo'].includes(effectiveRole(graph, attempts.get(r.attempt_id)))).map((r) => r.id))
}

export function nodeRole(node: GraphNode, observed: ReadonlySet<string>) {
  if (node.kind === 'goal') return 'Goal'
  if (node.kind === 'milestone') return 'Milestone'
  if (node.kind === 'restoration') return 'Restoration'
  if (node.kind === 'observed' || (node.source_result_id && observed.has(node.source_result_id)))
    return 'Observed state'
  return 'Proposed state'
}
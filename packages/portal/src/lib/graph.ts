import { request } from './api'

export interface GraphPolicy {
  agents: string[]
  grader: string
  decomposer: string
  fallback: string | null
  capacity: number
  threshold: number
  review: boolean
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
  proposals: { id: string; status: string; content: string; source_result_id: string }[]
  evidence: {
    node_id: string
    resource_id: string
    predicate: string
    value: string
    source_result_id: string
  }[]
  resource_links: { node_id: string; resource_id: string }[]
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
export const defaultGraphPolicy: GraphPolicy = {
  agents: [],
  grader: '',
  decomposer: '',
  fallback: null,
  capacity: 1,
  threshold: 0.5,
  review: true,
  deadline_ms: 1800_000,
  max_attempts: 3,
  attempt_budget: 100,
  cost_budget: 100,
  recovery_budget: 25,
  planning_budget: 20,
  ttl_ms: 86400_000,
  maintenance_ms: 3600_000,
  freshness_ms: 86400_000
}

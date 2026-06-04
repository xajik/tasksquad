// ── Status literals ───────────────────────────────────────────────────────────

export type PlannerStatus    = 'pending' | 'running' | 'completed' | 'failed'
export type PhaseStatus      = 'pending' | 'in_progress' | 'completed' | 'failed' | 'reverted'
export type PlannerVerdict   = 0 | 1   // 1 = approved (👍), 0 = rejected (👎)
export type PhaseVerdict     = 'approved' | 'rejected'
export type SupervisorStatus = 'pending' | 'running' | 'completed' | 'failed'
export type SupervisorVerdict = 'yes' | 'no'

// ── DB row shapes (mirror columns exactly — D1 booleans are 0 | 1) ────────────

export interface PlannerRow {
  id: string
  team_id: string
  sender_id: string
  name: string
  description: string | null
  status: PlannerStatus
  current_phase_index: number
  max_retries: number
  auto_close: number               // 0 | 1
  paused: number                   // 0 | 1
  default_sub_agent_id: string | null
  default_harness_agent_id: string | null
  planner_verdict: PlannerVerdict | null
  created_at: number
  updated_at: number
}

export interface PhaseRow {
  id: string
  planner_id: string
  phase_index: number
  name: string
  sub_agent_id: string | null
  harness_agent_id: string | null
  status: PhaseStatus
  task_id: string | null
  retry_count: number
  max_retries: number
  auto_close: number               // 0 | 1
  user_verdict: PhaseVerdict | null
  last_response: string | null
  supervisor_status: SupervisorStatus | null
  supervisor_verdict: SupervisorVerdict | null
  created_at: number
  updated_at: number
}

// ── VerdictSource — discriminated union ───────────────────────────────────────
//
// Each signal that can resolve a phase verdict is a distinct variant.
// Adding a new source (CI webhook, external approval) = add a new variant only;
// the engine routes by `kind` and existing branches remain unchanged.

export type VerdictSource =
  | { kind: 'inbox_grade'; grade: 0 | 1 }         // user thumbs-up/down in inbox
  | { kind: 'auto_close' }                          // task closed with auto_close = true
  | { kind: 'supervisor'; verdict: SupervisorVerdict }  // JSON from supervisor agent

// ── PhaseDispatchRequest — data the engine hands to the dispatcher ─────────────

export interface PhaseDispatchRequest {
  planner: PlannerRow
  phase: PhaseRow
  teamId: string
  senderId: string    // user who created the planner — used as task sender
  previousContext: string | null  // last_response of previous phase, or planner description for phase 0
}

// ── PlannerEvent — named events emitted by the engine ─────────────────────────
//
// Useful for logging, test assertions, and future notification hooks.

export type PlannerEvent =
  | { type: 'phase_dispatched';      plannerId: string; phaseId: string; taskId: string }
  | { type: 'phase_completed';       plannerId: string; phaseId: string }
  | { type: 'phase_retried';         plannerId: string; phaseId: string; retryCount: number }
  | { type: 'phase_failed';          plannerId: string; phaseId: string; reason: string }
  | { type: 'planner_completed';     plannerId: string }
  | { type: 'planner_failed';        plannerId: string }
  | { type: 'planner_paused';        plannerId: string }
  | { type: 'supervisor_dispatched'; plannerId: string; phaseId: string; taskId: string }

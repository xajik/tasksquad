import { ulid } from 'ulidx'
import type { PhaseRow, PlannerRow, SupervisorVerdict } from './types.js'
import { buildSupervisorBody } from './templates.js'

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IVerificationStrategy {
  /** Whether this phase needs supervisor verification before advancing. */
  shouldVerify(phase: PhaseRow): boolean

  /** Dispatch a supervisor task and return its task ID. */
  dispatch(db: D1Database, planner: PlannerRow, phase: PhaseRow): Promise<string>

  /**
   * Parse the supervisor agent's final message into a verdict.
   * Returns null when the response is malformed — treated as 'no' by the engine.
   */
  parseResponse(body: string): SupervisorVerdict | null
}

// ── Default implementation ────────────────────────────────────────────────────

export class DefaultSupervisorStrategy implements IVerificationStrategy {
  /** Supervisor check is opt-in per phase; the column is not yet in v1 UI so always false. */
  shouldVerify(_phase: PhaseRow): boolean {
    return false
  }

  async dispatch(db: D1Database, planner: PlannerRow, phase: PhaseRow): Promise<string> {
    const taskId  = ulid()
    const now     = Date.now()
    const subject = `[Supervisor] Verify: ${phase.name}`
    const msgBody = buildSupervisorBody(planner.name, phase.name, phase.last_response ?? '')
    const agentId = planner.default_harness_agent_id ?? phase.harness_agent_id

    await db.batch([
      db.prepare(`
        INSERT INTO tasks
          (id, team_id, agent_id, sender_id, subject, status, auto_close, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 1, ?)
      `).bind(taskId, planner.team_id, agentId, planner.sender_id, subject, now),
      db.prepare(`
        INSERT INTO planner_task (id, planner_id, phase_id, task_id, role, created_at)
        VALUES (?, ?, ?, ?, 'supervisor', ?)
      `).bind(ulid(), planner.id, phase.id, taskId, now),
      db.prepare(`
        INSERT INTO messages (id, task_id, sender_id, role, type, body, created_at)
        VALUES (?, ?, ?, 'user', 'inbox', ?, ?)
      `).bind(ulid(), taskId, planner.sender_id, msgBody, now),
    ])

    return taskId
  }

  parseResponse(body: string): SupervisorVerdict | null {
    try {
      // Regex-wrapped parse handles LLM responses that wrap JSON in prose
      const raw = body.match(/\{[\s\S]*\}/)?.[0] ?? ''
      const parsed = JSON.parse(raw) as { approved?: unknown }
      if (typeof parsed.approved === 'boolean') {
        return parsed.approved ? 'yes' : 'no'
      }
    } catch { /* fall through */ }
    return null
  }
}

import { ulid } from 'ulidx'
import type { PhaseDispatchRequest } from './types.js'

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IPhaseDispatcher {
  /** Create an inbox task for the given phase and return its new task ID. */
  dispatch(db: D1Database, req: PhaseDispatchRequest): Promise<string>

  /** Called when a phase is reverted — implementors may cancel the previous task. */
  revert?(db: D1Database, phaseId: string, previousTaskId: string): Promise<void>
}

// ── Default implementation — creates a standard inbox task ───────────────────

export class TaskDispatcher implements IPhaseDispatcher {
  async dispatch(db: D1Database, req: PhaseDispatchRequest): Promise<string> {
    const { planner, phase, teamId, senderId } = req
    const taskId  = ulid()
    const now     = Date.now()
    const subject = `[${planner.name}] Phase ${phase.phase_index + 1}: ${phase.name}`

    // Inherit planner-level harness if the phase has none
    const agentId = phase.harness_agent_id ?? planner.default_harness_agent_id

    await db.batch([
      db.prepare(`
        INSERT INTO tasks
          (id, team_id, agent_id, sender_id, subject, status, auto_close, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).bind(taskId, teamId, agentId, senderId, subject, phase.auto_close, now),
      db.prepare(`
        INSERT INTO planner_task (id, planner_id, phase_id, task_id, role, created_at)
        VALUES (?, ?, ?, ?, 'phase', ?)
      `).bind(ulid(), planner.id, phase.id, taskId, now),
      db.prepare(`
        INSERT INTO messages (id, task_id, sender_id, role, type, body, created_at)
        VALUES (?, ?, ?, 'user', 'inbox', ?, ?)
      `).bind(ulid(), taskId, senderId, subject, now),
    ])

    return taskId
  }
}

import type { PlannerRow, PhaseRow, VerdictSource, PlannerEvent } from './types.js'
import type { IPhaseDispatcher } from './dispatcher.js'
import type { IVerificationStrategy } from './supervisor.js'

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IPlannerEngine {
  /**
   * Called when a verdict signal arrives for a phase task or supervisor task.
   * Resolves the role + phase from planner_task, then routes accordingly.
   */
  onVerdict(
    db: D1Database,
    taskId: string,
    source: VerdictSource,
  ): Promise<PlannerEvent[]>

  /**
   * Advances the planner to the next phase. No-op when paused/completed/failed.
   * Dispatches the next phase task atomically.
   */
  advance(db: D1Database, plannerId: string): Promise<PlannerEvent[]>

  /**
   * Reverts the current phase attempt and re-dispatches it.
   * Marks planner FAILED when max_retries is exhausted.
   */
  retry(db: D1Database, phaseId: string): Promise<PlannerEvent[]>

  /**
   * Clears the paused flag. If the current phase is already completed + approved,
   * immediately calls advance() to dispatch the next one.
   */
  resume(db: D1Database, plannerId: string): Promise<PlannerEvent[]>
}

// ── Implementation ────────────────────────────────────────────────────────────

export class PlannerEngine implements IPlannerEngine {
  constructor(
    private readonly dispatcher: IPhaseDispatcher,
    private readonly verifier: IVerificationStrategy,
  ) {}

  // ── onVerdict ──────────────────────────────────────────────────────────────

  async onVerdict(
    db: D1Database,
    taskId: string,
    source: VerdictSource,
  ): Promise<PlannerEvent[]> {
    const link = await db
      .prepare('SELECT phase_id, role FROM planner_task WHERE task_id = ?')
      .bind(taskId)
      .first<{ phase_id: string; role: string } | null>()
    if (!link) return []

    const phase = await db
      .prepare('SELECT * FROM planner_phases WHERE id = ?')
      .bind(link.phase_id)
      .first<PhaseRow>()
    if (!phase) return []

    const planner = await db
      .prepare('SELECT * FROM planners WHERE id = ?')
      .bind(phase.planner_id)
      .first<PlannerRow>()
    if (!planner) return []

    if (link.role === 'supervisor') {
      return this.resolveSupervisorVerdict(db, phase, planner, source)
    }
    return this.resolvePhaseVerdict(db, phase, planner, source, taskId)
  }

  // ── advance ────────────────────────────────────────────────────────────────

  async advance(db: D1Database, plannerId: string): Promise<PlannerEvent[]> {
    const planner = await db
      .prepare('SELECT * FROM planners WHERE id = ?')
      .bind(plannerId)
      .first<PlannerRow>()
    if (!planner) return []

    // Bail out if the planner is in a terminal or paused state
    if (planner.paused)                                          return [{ type: 'planner_paused', plannerId }]
    if (planner.status === 'completed' || planner.status === 'failed') return []

    const nextIndex = planner.current_phase_index + 1

    // Count total phases to detect completion
    const { count } = await db
      .prepare('SELECT COUNT(*) as count FROM planner_phases WHERE planner_id = ?')
      .bind(plannerId)
      .first<{ count: number }>() ?? { count: 0 }

    if (nextIndex >= count) {
      // All phases done — mark planner completed
      await db
        .prepare('UPDATE planners SET status = ?, updated_at = ? WHERE id = ?')
        .bind('completed', Date.now(), plannerId)
        .run()
      return [{ type: 'planner_completed', plannerId }]
    }

    // Load the next phase
    const nextPhase = await db
      .prepare('SELECT * FROM planner_phases WHERE planner_id = ? AND phase_index = ?')
      .bind(plannerId, nextIndex)
      .first<PhaseRow>()
    if (!nextPhase) return []

    const now = Date.now()

    // Atomically advance planner index + mark next phase in_progress
    await db.batch([
      db.prepare('UPDATE planners SET current_phase_index = ?, status = ?, updated_at = ? WHERE id = ?')
        .bind(nextIndex, 'running', now, plannerId),
      db.prepare('UPDATE planner_phases SET status = ?, updated_at = ? WHERE id = ?')
        .bind('in_progress', now, nextPhase.id),
    ])

    // Dispatch the phase task (separate write so we can store the returned task ID)
    const taskId = await this.dispatcher.dispatch(db, {
      planner,
      phase: nextPhase,
      teamId: planner.team_id,
      senderId: planner.sender_id,
    })

    await db
      .prepare('UPDATE planner_phases SET task_id = ?, updated_at = ? WHERE id = ?')
      .bind(taskId, Date.now(), nextPhase.id)
      .run()

    return [{ type: 'phase_dispatched', plannerId, phaseId: nextPhase.id, taskId }]
  }

  // ── retry ──────────────────────────────────────────────────────────────────

  async retry(db: D1Database, phaseId: string): Promise<PlannerEvent[]> {
    const phase = await db
      .prepare('SELECT * FROM planner_phases WHERE id = ?')
      .bind(phaseId)
      .first<PhaseRow>()
    if (!phase) return []

    const planner = await db
      .prepare('SELECT * FROM planners WHERE id = ?')
      .bind(phase.planner_id)
      .first<PlannerRow>()
    if (!planner) return []

    if (phase.retry_count >= phase.max_retries) {
      // Retries exhausted — fail both phase and planner atomically
      const now = Date.now()
      await db.batch([
        db.prepare('UPDATE planner_phases SET status = ?, updated_at = ? WHERE id = ?')
          .bind('failed', now, phaseId),
        db.prepare('UPDATE planners SET status = ?, updated_at = ? WHERE id = ?')
          .bind('failed', now, planner.id),
      ])
      return [
        { type: 'phase_failed', plannerId: planner.id, phaseId, reason: 'max_retries_exceeded' },
        { type: 'planner_failed', plannerId: planner.id },
      ]
    }

    const now = Date.now()

    // Reset phase for re-dispatch — clear all verdict / task refs
    await db
      .prepare(`
        UPDATE planner_phases SET
          retry_count = ?,
          status = 'reverted',
          task_id = NULL,
          user_verdict = NULL,
          supervisor_status = NULL,
          supervisor_verdict = NULL,
          updated_at = ?
        WHERE id = ?
      `)
      .bind(phase.retry_count + 1, now, phaseId)
      .run()

    // Re-dispatch
    const taskId = await this.dispatcher.dispatch(db, {
      planner,
      phase: { ...phase, task_id: null, retry_count: phase.retry_count + 1 },
      teamId: planner.team_id,
      senderId: planner.sender_id,
    })

    await db
      .prepare('UPDATE planner_phases SET status = ?, task_id = ?, updated_at = ? WHERE id = ?')
      .bind('in_progress', taskId, Date.now(), phaseId)
      .run()

    return [{ type: 'phase_retried', plannerId: planner.id, phaseId, retryCount: phase.retry_count + 1 }]
  }

  // ── resume ─────────────────────────────────────────────────────────────────

  async resume(db: D1Database, plannerId: string): Promise<PlannerEvent[]> {
    const now = Date.now()

    await db
      .prepare('UPDATE planners SET paused = 0, updated_at = ? WHERE id = ?')
      .bind(now, plannerId)
      .run()

    // If the current phase already has a passing verdict, advance immediately
    const planner = await db
      .prepare('SELECT * FROM planners WHERE id = ?')
      .bind(plannerId)
      .first<PlannerRow>()
    if (!planner) return []

    const currentPhase = await db
      .prepare('SELECT * FROM planner_phases WHERE planner_id = ? AND phase_index = ?')
      .bind(plannerId, planner.current_phase_index)
      .first<PhaseRow>()

    if (
      currentPhase?.status === 'completed' &&
      currentPhase.user_verdict === 'approved' &&
      !currentPhase.supervisor_status
    ) {
      return this.advance(db, plannerId)
    }

    return []
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async resolvePhaseVerdict(
    db: D1Database,
    phase: PhaseRow,
    planner: PlannerRow,
    source: VerdictSource,
    taskId: string,
  ): Promise<PlannerEvent[]> {
    // Determine pass/fail from the source signal
    const pass = source.kind === 'auto_close'
      ? true
      : source.kind === 'inbox_grade'
        ? source.grade === 1
        : false

    const now = Date.now()
    const events: PlannerEvent[] = []

    if (pass) {
      // Fetch the agent's last message as the phase output for the next phase / supervisor
      const lastMsg = await db
        .prepare(`
          SELECT body FROM messages
          WHERE task_id = ? AND role = 'agent'
          ORDER BY created_at DESC LIMIT 1
        `)
        .bind(taskId)
        .first<{ body: string }>()

      await db
        .prepare(`
          UPDATE planner_phases SET
            status = 'completed',
            user_verdict = 'approved',
            last_response = ?,
            updated_at = ?
          WHERE id = ?
        `)
        .bind(lastMsg?.body ?? null, now, phase.id)
        .run()

      events.push({ type: 'phase_completed', plannerId: planner.id, phaseId: phase.id })

      // Check whether we need a supervisor verification before advancing
      const updatedPhase = { ...phase, status: 'completed' as const, last_response: lastMsg?.body ?? null }
      if (this.verifier.shouldVerify(updatedPhase)) {
        const supTaskId = await this.verifier.dispatch(db, planner, updatedPhase)
        await db
          .prepare(`
            UPDATE planner_phases SET
              supervisor_status = 'running',
              updated_at = ?
            WHERE id = ?
          `)
          .bind(Date.now(), phase.id)
          .run()
        events.push({ type: 'supervisor_dispatched', plannerId: planner.id, phaseId: phase.id, taskId: supTaskId })
      } else {
        // No supervisor — advance directly
        events.push(...await this.advance(db, planner.id))
      }
    } else {
      // Phase failed — mark rejected and retry
      await db
        .prepare('UPDATE planner_phases SET user_verdict = ?, updated_at = ? WHERE id = ?')
        .bind('rejected', now, phase.id)
        .run()
      events.push(...await this.retry(db, phase.id))
    }

    return events
  }

  private async resolveSupervisorVerdict(
    db: D1Database,
    phase: PhaseRow,
    planner: PlannerRow,
    source: VerdictSource,
  ): Promise<PlannerEvent[]> {
    if (source.kind !== 'supervisor') return []

    const now = Date.now()

    await db
      .prepare(`
        UPDATE planner_phases SET
          supervisor_status = 'completed',
          supervisor_verdict = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .bind(source.verdict, now, phase.id)
      .run()

    if (source.verdict === 'yes') {
      return this.advance(db, planner.id)
    }
    return this.retry(db, phase.id)
  }
}

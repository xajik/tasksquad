/**
 * Shared planner hook — called by both tasks.ts and daemon.ts whenever a
 * planner-linked task transitions to "done".  Callers are responsible for
 * wrapping in a try/catch so that planner errors never fail the outer request.
 */

import { PlannerEngine } from './engine.js'
import { TaskDispatcher } from './dispatcher.js'
import { DefaultSupervisorStrategy } from './supervisor.js'
import type { VerdictSource } from './types.js'

const supervisorStrategy = new DefaultSupervisorStrategy()

export function makePlannerEngine(): PlannerEngine {
  return new PlannerEngine(new TaskDispatcher(), supervisorStrategy)
}

async function isLastPhase(db: D1Database, phaseId: string): Promise<boolean> {
  const phase = await db
    .prepare('SELECT phase_index, planner_id FROM planner_phases WHERE id = ?')
    .bind(phaseId)
    .first<{ phase_index: number; planner_id: string } | null>()
  if (!phase) return false
  const row = await db
    .prepare('SELECT COUNT(*) as count FROM planner_phases WHERE planner_id = ?')
    .bind(phase.planner_id)
    .first<{ count: number }>()
  return phase.phase_index === (row?.count ?? 0) - 1
}

async function getLastAgentMessage(db: D1Database, taskId: string): Promise<string | null> {
  const msg = await db
    .prepare("SELECT body FROM messages WHERE task_id = ? AND role = 'agent' ORDER BY created_at DESC LIMIT 1")
    .bind(taskId)
    .first<{ body: string }>()
  return msg?.body ?? null
}

/**
 * Resolves the planner verdict for a task that just completed.
 * Throws on DB/engine errors — wrap the call site in try/catch.
 */
export async function onTaskDone(db: D1Database, taskId: string): Promise<void> {
  const link = await db
    .prepare('SELECT role, phase_id FROM planner_task WHERE task_id = ?')
    .bind(taskId)
    .first<{ role: string; phase_id: string } | null>()
  if (!link) return

  const engine = makePlannerEngine()
  const lastText = await getLastAgentMessage(db, taskId)

  if (link.role === 'supervisor') {
    const verdict = supervisorStrategy.parseResponse(lastText ?? '')
    if (verdict === null) {
      console.warn(
        '[planner] supervisor verdict unparseable for task', taskId,
        '— defaulting to "no". Response preview:', (lastText ?? '').slice(0, 200),
      )
    }
    const source: VerdictSource = { kind: 'supervisor', verdict: verdict ?? 'no' }
    await engine.onVerdict(db, taskId, source)
    return
  }

  // Phase task — auto-close when the flag is set or this is the final phase
  const task = await db
    .prepare('SELECT auto_close FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ auto_close: number }>()

  if (task?.auto_close || await isLastPhase(db, link.phase_id)) {
    // Last phase auto-completes the planner without requiring manual review
    await engine.onVerdict(db, taskId, { kind: 'auto_close' })
    return
  }

  // Non-auto-close, non-last phase: persist output so UI can show Proceed/Stop
  if (lastText && link.phase_id) {
    await db
      .prepare('UPDATE planner_phases SET last_response = ?, updated_at = ? WHERE id = ?')
      .bind(lastText, Date.now(), link.phase_id)
      .run()
  }
}

import { queueDone } from '../queue.js'
import { assignment, sql, type Assignment, type Data } from '../../store.js'
import { actionable, compactOwnerHistory, continuationRoot, executionNodes, planContext, restartOwnerHistory } from '../shared.js'

import type { AcceptCtx } from './context.js'

export async function acceptContinue(x: AcceptCtx): Promise<void> {
  const { db, g, original, d, input, ops, enqueue } = x
  if (!input.serial_work_id)
    ops.push(
      queueDone(db, g.id, 'assignment', original.id)
    )
  const found = await sql(
    db,
    'SELECT * FROM graph_assignments WHERE id=?',
    original.parent_id
  ).first<Assignment>()
  if (!found) throw new Error('Missing blocked assignment')
  // A reply to a blocked continue must resume the step that started it, never spawn another
  // continue (that looped: continue -> restart -> continue ...).
  const { root: parent } = await continuationRoot(db, found)
  if (parent.role === 'continue') throw new Error('Continuation has no original assignment')
  if (d.decision === 'blocked')
    // The newest request belongs to this continuation, not its ancestor.
    ops.push(
      sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", original.id),
      sql(
        db,
        "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND work_id=?",
        g.id,
        input.serial_work_id ?? original.id
      )
    )
  else {
    // A fresh attempt is explicit; context records checkpoint semantics for the executor.
    // Judge the newest attempt: an older confirmed attempt must not mask a live later one.
    const latest = await sql(
      db,
      'SELECT session_id,termination_confirmed_at FROM graph_attempts WHERE assignment_id=? ORDER BY epoch DESC LIMIT 1',
      parent.id
    ).first<{ session_id: string | null; termination_confirmed_at: number | null }>()
    if (actionable(parent.role) && latest && latest.session_id && !latest.termination_confirmed_at)
      throw new Error('Previous process has not confirmed termination')
    if (
      actionable(parent.role) &&
      (d.termination_verified !== true ||
        d.baseline_unchanged !== true ||
        (d.decision === 'resume' && d.checkpoint_verified !== true))
    )
      throw new Error('Continuation needs verified termination, baseline and checkpoint')
    if (parent.role === 'execute' && input.serial_work_id)
      ops.push(
        sql(
          db,
          "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND work_id=? AND status='pending'",
          g.id,
          input.serial_work_id
        ),
        sql(
          db,
          "UPDATE graph_grading SET status='done' WHERE graph_id=? AND execution_result_id=?",
          g.id,
          input.serial_work_id
        )
      )
    if (d.decision === 'replan') {
      // The owner approved work that the current plan does not cover. Send it back to planning with the
      // approval as input; never make the owner author a plan or look up internal IDs.
      if (parent.role !== 'execute') throw new Error('replan applies only to a reviewed execution plan')
      const old = (JSON.parse(parent.input).plan ?? {}) as Data
      ops.push(sql(db, "UPDATE graph_assignments SET status='cancelled',cancel_reason='replanned' WHERE id=?", parent.id))
      await enqueue('plan', {
        task: {
          title: String(old.title ?? 'Revised plan'),
          description: String(old.description ?? ''),
          body: `Revise the plan to cover the owner-approved work. Previous plan: ${String(old.body ?? '')}`.slice(0, 3999)
        },
        ...(await planContext(db, g.id)),
        feedback: {
          owner_approval: compactOwnerHistory([...((input.prior_user_inputs as string[]) ?? []), String(input.user_input ?? '')]).join('\n\nFollow-up:\n'),
          reason: String(d.reason ?? '')
        }
      })
      return
    }
    const previousContext = JSON.parse(parent.input)
    const context = {
      ...previousContext,
      ...(parent.role === 'merge' && previousContext.direction !== 'backward'
        ? { existing_states: await executionNodes(db, g.id) }
        : {}),
      ...(parent.role === 'plan'
        ? await planContext(db, g.id)
        : {}),
      continuation: d,
      user_input: compactOwnerHistory([
        ...(await restartOwnerHistory(db, g.id, parent)),
        ...((input.prior_user_inputs as string[]) ?? []),
        String(input.user_input ?? '')
      ]).join('\n\nFollow-up:\n'),
      ...(input.serial_work_id ? { serial_work_id: input.serial_work_id } : {})
    }
    const next = await assignment(db, g, parent.role, context, {
      parent: parent.id,
      node: parent.node_id,
      edge: parent.edge_id
    })
    ops.push(
      ...next.statements,
      sql(db, 'UPDATE graph_assignments SET max_attempts=1 WHERE id=?', next.id)
    )
  }
}

import { verifyGoal } from '../../contracts.js'
import { queueDone } from '../queue.js'
import { rows, sql, type Data } from '../../store.js'
import { executedLineage, planContext } from '../shared.js'

import type { AcceptCtx } from './context.js'

export async function acceptReview(x: AcceptCtx): Promise<void> {
  const { db, g, r, original, c, d, input, ops, enqueue } = x
  if (original.role === 'project' && input.operation === 'decomposition_review') {
    const allowed = (input.evidence as Data[]).map((e) => e.id)
    if ((d.evidence_ids as string[]).some((e) => !allowed.includes(e)))
      throw new Error('Review references unsupplied evidence')
    const feedback = (d.decomposition_feedback as unknown[] | undefined) ?? []
    const running = await sql(
      db,
      "SELECT 1 FROM graph_assignments WHERE graph_id=? AND role='decompose' AND status IN ('running','review') LIMIT 1",
      g.id
    ).first()
    if (feedback.length && !running) {
      ops.push(
        sql(
          db,
          "UPDATE graph_assignments SET status='cancelled',cancel_reason='superseded' WHERE graph_id=? AND role='decompose' AND status='pending' AND attempt_count=0",
          g.id
        )
      )
      await enqueue('decompose', {
        goal: g.body,
        title: g.title,
        success_rule: c.rule,
        existing_milestones: input.hierarchy,
        abstract_feedback: feedback
      })
    }
    ops.push(
      queueDone(db, g.id, 'assignment', input.serial_work_id ?? original.id)
    )
    return
  }

  const ids = d.evidence_ids as string[]
  const allowed = (input.evidence as Data[]).map((e) => e.id)
  if (ids.some((e) => !allowed.includes(e))) throw new Error('Grade references unsupplied evidence')
  ops.push(
    sql(
      db,
      'INSERT INTO graph_evaluation_revisions(graph_id,execution_result_id,role,source_result_id,created_at) VALUES(?,?,?,?,?)',
      g.id,
      input.execution_result_id,
      original.role,
      r.id,
      Date.now()
    )
  )
  // The stored goal score ranks the candidate; per-goal detail stays in the result itself.
  // Rank by the goal this node moved the most (a milestone counts), not only the far-off root goal.
  const impacts = (d.goal_impacts ?? []) as Data[]
  const rootScore = impacts.length ? Math.max(...impacts.map((i) => Number(i.actual))) : d.goal_score
  const lineage = await executedLineage(db, g.id, original.edge_id)
  for (const edge of lineage)
    for (const evidence of ids)
      ops.push(
        sql(
          db,
          'INSERT INTO graph_evaluations(graph_id,edge_id,source_result_id,evidence_id,context,local_score,goal_score,created_at) VALUES(?,?,?,?,?,?,?,?)',
          g.id,
          edge,
          r.id,
          evidence,
          `${input.execution_result_id}:${original.role}:${edge}`,
          original.role === 'grade' ? d.local_score : null,
          original.role === 'project' ? rootScore : null,
          Date.now()
        )
      )
  ops.push(
    sql(
      db,
      'UPDATE graph_grading SET stage=?,assignment_id=NULL,status=? WHERE sequence=?',
      original.role === 'grade' ? 'project' : 'done',
      original.role === 'grade' ? 'pending' : 'done',
      input.grading_sequence
    )
  )
  if (original.role === 'project')
    ops.push(
      sql(
        db,
        "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND kind='execution' AND work_id=? AND status='pending'",
        g.id,
        input.execution_result_id
      )
    )
  if (
    original.role === 'project' &&
    (input.result as Data).outcome === 'complete' &&
    g.status === 'running'
  ) {
    const evidence = await rows<{
      predicate: string
      value: 'true' | 'false' | 'unknown'
      scope: string
      expires_at: number
    }>(db, 'SELECT * FROM graph_evidence WHERE graph_id=?', g.id)
    if (verifyGoal(c.rule, evidence, Date.now()) !== 'true') {
      // Every graded execution used to start its own "next experiment", so concurrent planners re-proposed the same
      // ideas. One planner at a time: skip while one is in flight, and replace an unstarted one (its context is stale).
      const inFlight = await sql(
        db,
        "SELECT 1 FROM graph_assignments WHERE graph_id=? AND role='plan' AND status IN ('running','review','blocked','continuation') LIMIT 1",
        g.id
      ).first()
      if (inFlight) return
      ops.push(
        sql(
          db,
          "UPDATE graph_assignments SET status='cancelled',cancel_reason='superseded' WHERE graph_id=? AND role='plan' AND status='pending' AND attempt_count=0",
          g.id
        )
      )
      await enqueue('plan', {
        task: {
          title: 'Next bounded experiment',
          description: '',
          body: 'Explore alternatives from observed results'
        },
        ...(await planContext(db, g.id)),
        feedback: { goal_alignment: d.goal_score }
      })
    }
  }
}

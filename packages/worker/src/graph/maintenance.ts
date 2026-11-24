import type { Env } from '../types.js'
import {
  assignment,
  commit,
  configuration,
  graph,
  rows,
  sql,
  type Assignment,
  type Attempt,
  releaseRecovery
} from './store.js'
import { retryDelay } from './engine.js'
import { hash } from './contracts.js'

export async function maintenance(env: Pick<Env, 'DB'>, graphId: string): Promise<void> {
  const db = env.DB,
    g = await graph(db, graphId),
    c = await configuration(db, g),
    now = Date.now()
  // Coalesce legacy, unstarted decomposition revisions. Never cancel an attempt
  // that may already be executing or awaiting review.
  const redundant = await rows<{ id: string }>(
    db,
    `SELECT id FROM graph_assignments
    WHERE graph_id=? AND role='decompose' AND status='pending' AND attempt_count=0
    ORDER BY created_at DESC,id DESC`,
    g.id
  )
  if (redundant.length > 1)
    await commit(
      db,
      g,
      'decomposition_superseded',
      null,
      {},
      redundant
        .slice(1)
        .map((a) =>
          sql(
            db,
            "UPDATE graph_assignments SET status='cancelled',cancel_reason='superseded' WHERE id=?",
            a.id
          )
        )
    )
  const reviews = await rows<{ id: string; status: string; attempt_count: number }>(
    db,
    `SELECT id,status,attempt_count FROM graph_assignments
    WHERE graph_id=? AND role='project' AND json_extract(input,'$.operation')='decomposition_review'
    AND status IN ('pending','running','review','blocked','error','continuation')
    ORDER BY CASE WHEN status='pending' AND attempt_count=0 THEN 1 ELSE 0 END,created_at DESC,id DESC`,
    g.id
  )
  const superseded = reviews.slice(1).filter((a) => a.status === 'pending' && a.attempt_count === 0)
  if (superseded.length)
    await commit(
      db,
      g,
      'decomposition_reviews_superseded',
      null,
      {},
      superseded.map((a) =>
        sql(db, "UPDATE graph_assignments SET status='cancelled',cancel_reason='superseded' WHERE id=?", a.id)
      )
    )
  const expired = await rows<
    Attempt & {
      role: Assignment['role']
      input: string
      node_id: string | null
      edge_id: string | null
      attempt_count: number
      max_attempts: number
    }
  >(
    db,
    `SELECT t.*,a.role,a.input,a.node_id,a.edge_id,a.attempt_count,a.max_attempts FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? AND t.status IN ('pending','running') AND t.deadline<=? AND NOT EXISTS(SELECT 1 FROM graph_results r WHERE r.attempt_id=t.id AND r.status!='stale')`,
    g.id,
    now
  )
  for (const t of expired) {
    const ops = [
      sql(db, "UPDATE graph_attempts SET status='timeout',completed_at=? WHERE id=?", now, t.id),
      sql(db, "UPDATE tasks SET status='failed',completed_at=? WHERE id=?", now, t.task_id)
    ]
    if (t.role === 'execute' || t.role === 'undo') {
      if (t.session_id) {
        const next = await assignment(
          db,
          g,
          'reconcile',
          {
            interrupted_attempt: t.id,
            session_id: t.session_id,
            task_id: t.task_id,
            plan: JSON.parse(t.input).plan,
            reason: 'deadline_or_stop'
          },
          { parent: t.assignment_id, node: t.node_id, edge: t.edge_id }
        )
        ops.push(
          ...next.statements,
          sql(db, "UPDATE graph_assignments SET status='reconciling' WHERE id=?", t.assignment_id)
        )
      } else
        ops.push(
          sql(
            db,
            'UPDATE graph_assignments SET status=?,available_at=? WHERE id=?',
            t.attempt_count < t.max_attempts && g.status === 'running' ? 'pending' : 'error',
            now + retryDelay(t.attempt_count),
            t.assignment_id
          ),
          sql(db, 'DELETE FROM graph_reservations WHERE attempt_id=?', t.id)
        )
    } else
      ops.push(
        sql(
          db,
          'UPDATE graph_assignments SET status=?,available_at=? WHERE id=?',
          t.attempt_count < t.max_attempts ? 'pending' : 'error',
          now + retryDelay(t.attempt_count),
          t.assignment_id
        ),
        sql(db, 'DELETE FROM graph_reservations WHERE attempt_id=?', t.id)
      )
    if (t.role === 'execute' && !t.session_id)
      ops.push(
        releaseRecovery(db, g.id, Number(JSON.parse(t.input).plan.recovery_cost))
      )
    await commit(db, g, 'timeout', t.id, {}, ops)
  }
  const jobs = await rows<{ kind: string }>(
    db,
    'SELECT kind FROM graph_maintenance WHERE graph_id=? AND next_at<=?',
    g.id,
    now
  )
  for (const job of jobs) {
    const ops: D1PreparedStatement[] = [
      sql(
        db,
        'UPDATE graph_maintenance SET next_at=? WHERE graph_id=? AND kind=?',
        now + (job.kind === 'timeout' ? 30_000 : c.policy.maintenance_ms),
        g.id,
        job.kind
      )
    ]
    if (job.kind === 'cleanup') {
      // Work queued behind a blocked or reconciling step is starved, not stale:
      // expiring it would deactivate healthy nodes until the owner unblocks the graph.
      const stalled = await sql(
        db,
        "SELECT 1 FROM graph_assignments WHERE graph_id=? AND status IN ('blocked','error','reconciling') LIMIT 1",
        g.id
      ).first()
      const stale = stalled ? [] : await rows<Assignment>(
        db,
        "SELECT * FROM graph_assignments WHERE graph_id=? AND status='pending' AND role IN ('plan','merge','execute') AND available_at<?",
        g.id,
        now - c.policy.ttl_ms
      )
      for (const a of stale) {
        ops.push(sql(db, "UPDATE graph_assignments SET status='expired' WHERE id=?", a.id))
        if (a.node_id)
          ops.push(
            sql(
              db,
              "INSERT INTO graph_node_states(graph_id,node_id,state,reason,created_at) VALUES(?,?,'deactivated','expired',?)",
              g.id,
              a.node_id,
              now
            )
          )
      }
    }
    if (job.kind === 'revival' && g.status === 'running') {
      const busy = await sql(
        db,
        "SELECT 1 FROM graph_assignments WHERE graph_id=? AND status IN ('pending','running','review','blocked','continuation','reconciling') LIMIT 1",
        g.id
      ).first()
      if (!busy) {
        const paths = await rows(
          db,
          `SELECT n.id,n.title,n.description,n.body,s.reason FROM graph_nodes n JOIN graph_node_states s ON s.id=(SELECT MAX(id) FROM graph_node_states WHERE node_id=n.id) WHERE n.graph_id=? AND s.state='deactivated' `,
          g.id
        )
        if (paths.length) {
          const next = await assignment(db, g, 'plan', {
            task: 'Review deactivated paths and their reasons. Propose new bounded alternatives; preserve user gates.',
            paths,
            observed_start: g.start_state
          })
          ops.push(...next.statements)
        }
      }
    }
    if (job.kind === 'decomposition' && g.status === 'running') {
      const busy = await sql(
        db,
        `SELECT 1 FROM graph_assignments WHERE graph_id=?
         AND (role='decompose' OR (role='project' AND json_extract(input,'$.operation')='decomposition_review'))
         AND status IN ('pending','running','review','blocked','error','continuation') LIMIT 1`,
        g.id
      ).first()
      if (!busy) {
        const milestones = await rows(
          db,
          `SELECT title,description,body FROM graph_nodes n WHERE graph_id=? AND kind='milestone'
           AND NOT EXISTS(SELECT 1 FROM graph_node_states s WHERE s.id=(SELECT MAX(id) FROM graph_node_states WHERE node_id=n.id) AND s.state='deactivated') ORDER BY n.id`,
          g.id
        )
        const evidence = await rows(db, 'SELECT * FROM graph_evidence WHERE graph_id=? AND expires_at>? ORDER BY id', g.id, now)
        const contextHash = await hash(JSON.stringify([c.version, milestones, evidence]))
        const reviewed = await sql(
          db,
          `SELECT 1 FROM graph_assignments WHERE graph_id=? AND role='project'
          AND json_extract(input,'$.review_context_hash')=? AND status NOT IN ('cancelled','expired') LIMIT 1`,
          g.id,
          contextHash
        ).first()
        if (reviewed) {
          await ops[0].run()
          continue
        }
        const next = await assignment(db, g, 'project', {
          operation: 'decomposition_review',
          review_context_hash: contextHash,
          private_goal: g.body,
          rule: c.rule,
          hierarchy: milestones,
          evidence
        })
        ops.push(
          sql(
            db,
            "INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,'assignment',?,?)",
            g.id,
            next.id,
            Date.now()
          )
        )
        ops.push(...next.statements)
      }
    }
    if (ops.length === 1) {
      await ops[0].run()
      continue
    }
    await commit(db, g, `maintenance_${job.kind}`, null, {}, ops)
  }
}

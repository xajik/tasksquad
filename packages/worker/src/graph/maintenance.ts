import type { Env } from '../types.js'
import {
  assignment,
  commit,
  configuration,
  graph,
  rows,
  sql,
  type Assignment,
  type Attempt
} from './store.js'
import { retryDelay } from './engine.js'

export async function maintenance(env: Pick<Env, 'DB'>, graphId: string): Promise<void> {
  const db = env.DB,
    g = await graph(db, graphId),
    c = await configuration(db, g),
    now = Date.now()
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
        sql(
          db,
          'UPDATE graph_budgets SET recovery_reserved=MAX(0,recovery_reserved-?) WHERE graph_id=?',
          Number(JSON.parse(t.input).plan.recovery_cost),
          g.id
        )
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
      const stale = await rows<Assignment>(
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
          `SELECT n.id,n.title,n.description,n.body,s.reason FROM graph_nodes n JOIN graph_node_states s ON s.id=(SELECT MAX(id) FROM graph_node_states WHERE node_id=n.id) WHERE n.graph_id=? AND s.state='deactivated' AND s.reason='expired'`,
          g.id
        )
        if (paths.length) {
          const next = await assignment(db, g, 'plan', {
            task: 'Review expired paths; propose new bounded alternatives. Preserve user gates.',
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
        "SELECT 1 FROM graph_assignments WHERE graph_id=? AND role='decompose' AND status IN ('pending','running','review') LIMIT 1",
        g.id
      ).first()
      if (!busy) {
        const milestones = await rows(
          db,
          "SELECT title,description,body FROM graph_nodes WHERE graph_id=? AND kind='milestone'",
          g.id
        )
        const next = await assignment(db, g, 'decompose', {
          goal: g.body,
          success_rule: c.rule,
          existing_milestones: milestones,
          instruction: 'Compare existing decomposition with evidence; return only missing milestones.'
        })
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

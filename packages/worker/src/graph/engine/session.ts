import { hash } from '../contracts.js'
import { EXECUTION_ROLES } from '../roles.js'
import { id, sql, type Assignment, type Attempt } from '../store.js'


import { type GraphEnv } from './shared.js'

/** Must be included in session-open's DB batch, so session FK and attempt bind are atomic. */
export async function bindStatement(
  db: D1Database,
  taskId: string,
  agentId: string,
  sessionId: string
): Promise<D1PreparedStatement[]> {
  const t = await sql(db, 'SELECT * FROM graph_attempts WHERE task_id=?', taskId).first<Attempt>()
  if (!t) return []
  if (t.agent_id !== agentId || t.status !== 'pending' || t.session_id || t.deadline <= Date.now())
    throw new Error('Unexpected graph run')
  return [
    sql(db, 'INSERT INTO graph_run_claims(task_id,session_id) VALUES(?,?)', taskId, sessionId),
    sql(
      db,
      "UPDATE graph_attempts SET session_id=?,status='running' WHERE id=? AND session_id IS NULL AND status='pending'",
      sessionId,
      t.id
    )
  ]
}

export async function intake(
  env: GraphEnv,
  sessionId: string,
  agentId: string,
  raw: string,
  hold = false
): Promise<string | null> {
  if (env.ACTION_GRAPH_ENABLED === undefined) return null
  const t = await sql(
    env.DB,
    'SELECT * FROM graph_attempts WHERE session_id=? AND agent_id=?',
    sessionId,
    agentId
  ).first<Attempt>()
  if (!t) return null
  const a = await sql(
    env.DB,
    'SELECT * FROM graph_assignments WHERE id=?',
    t.assignment_id
  ).first<Assignment>()
  if (!a) return null
  const existing = await sql(env.DB, 'SELECT id FROM graph_results WHERE attempt_id=?', t.id).first<{
    id: string
  }>()
  if (existing) return a.graph_id
  const resultId = id()
  const now = Date.now(),
    stale = t.status !== 'running' || t.epoch !== a.attempt_count || now > t.deadline
  // Size bounded before hashing/persistence. Oversize responses retain a diagnostic prefix.
  const bounded =
    new TextEncoder().encode(raw).length > 128 * 1024
      ? raw.slice(0, 60_000) + '\n[response exceeds limit]'
      : raw
  await env.DB.batch([
    sql(
      env.DB,
      'INSERT OR IGNORE INTO graph_results(id,attempt_id,raw,output_hash,status,created_at) VALUES(?,?,?,?,?,?)',
      resultId,
      t.id,
      bounded,
      await hash(bounded),
      stale ? 'stale' : 'received',
      now
    ),
    sql(
      env.DB,
      `INSERT OR IGNORE INTO messages(id,task_id,sender_id,role,body,created_at) SELECT id,?,NULL,'agent',raw,created_at FROM graph_results WHERE attempt_id=?`,
      t.task_id,
      t.id
    ),
    ...(a.role === 'execute' && !stale
      ? [
          sql(
            env.DB,
            `INSERT OR IGNORE INTO graph_grading(graph_id,execution_result_id,created_at) SELECT ?,id,? FROM graph_results WHERE attempt_id=?`,
            a.graph_id,
            now,
            t.id
          )
        ]
      : []),
    ...(a.role === 'execute' && !stale
      ? [
          sql(
            env.DB,
            `INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) SELECT ?,'execution',id,? FROM graph_results WHERE attempt_id=? AND NOT EXISTS(SELECT 1 FROM graph_serial_queue WHERE work_id=graph_results.id AND kind='execution')`,
            a.graph_id,
            now,
            t.id
          )
        ]
      : []),
    ...(!stale
      ? [
          sql(
            env.DB,
            "UPDATE graph_attempts SET status='completed',completed_at=? WHERE id=? AND status='running'",
            now,
            t.id
          ),
          // A daemon that will run the end-of-session steps keeps the session open and the agent busy until it
          // closes the session itself (closeHeldSession); otherwise the session ends with the result.
          ...(hold && (EXECUTION_ROLES as readonly string[]).includes(a.role) ? [] : closeSessionStatements(env.DB, agentId, sessionId, t.task_id, now))
        ]
      : [
          // A stale result still means the process has ended: free the agent so retries can dispatch.
          ...releaseAgentStatements(env.DB, agentId, sessionId, now)
        ])
  ])
  return a.graph_id
}

/** Ends a graph session: closes it and its inbox task and frees the agent. */
export function closeSessionStatements(
  db: D1Database,
  agentId: string,
  sessionId: string,
  taskId: string,
  now: number
): D1PreparedStatement[] {
  return [
    sql(db, "UPDATE sessions SET status='closed',closed_at=? WHERE id=?", now, sessionId),
    sql(db, "UPDATE tasks SET status='done',completed_at=? WHERE id=?", now, taskId),
    ...releaseAgentStatements(db, agentId, sessionId, now)
  ]
}

/** The daemon's idle self-heal never runs behind a 304, so closing a graph session must free its agent itself. */
export function releaseAgentStatements(
  db: D1Database,
  agentId: string,
  sessionId: string,
  now: number
): D1PreparedStatement[] {
  return [
    sql(
      db,
      "UPDATE agents SET status='idle' WHERE id=? AND EXISTS(SELECT 1 FROM agent_state WHERE agent_id=? AND current_session=?)",
      agentId,
      agentId,
      sessionId
    ),
    sql(
      db,
      "UPDATE agent_state SET current_task_id=NULL,current_session=NULL,mode='idle',updated_at=? WHERE agent_id=? AND current_session=?",
      now,
      agentId,
      sessionId
    )
  ]
}

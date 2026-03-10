import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'

async function requireMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.searchParams.get('agent_id')
  const status = url.searchParams.get('status')
  const teamId = url.searchParams.get('team_id')

  // Determine which team to scope to — require team_id query param for now
  if (!teamId) return err('team_id_required', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  let query = 'SELECT id, team_id, agent_id, sender_id, subject, status, created_at, started_at, completed_at FROM tasks WHERE team_id = ?'
  const binds: unknown[] = [teamId]

  if (agentId) { query += ' AND agent_id = ?'; binds.push(agentId) }
  if (status)  { query += ' AND status = ?';   binds.push(status) }
  query += ' ORDER BY created_at DESC LIMIT 100'

  const rows = await env.DB.prepare(query).bind(...binds).all()
  return json({ tasks: rows.results })
}

export async function get(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT id, team_id, agent_id, sender_id, subject, status, created_at, started_at, completed_at FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ id: string; team_id: string; agent_id: string; sender_id: string; subject: string; status: string; created_at: number; started_at: number | null; completed_at: number | null }>()

  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  return json(task)
}

export async function update(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]
  const body = await req.json<{ status?: string }>().catch(() => ({} as { status?: string }))

  if (!body.status) return err('status_required', 400)

  const task = await env.DB
    .prepare('SELECT team_id, status FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string; status: string }>()

  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  const now = Date.now()
  await env.DB.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
    .bind(body.status, body.status === 'done' || body.status === 'failed' ? now : null, taskId)
    .run()

  return json({ ok: true })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const body = await req.json<{ agent_id?: string; subject?: string; team_id?: string; body?: string }>().catch(() => ({} as { agent_id?: string; subject?: string; team_id?: string; body?: string }))
  const { agent_id, subject, team_id, body: taskBody } = body
  if (!agent_id || !subject?.trim() || !team_id) return err('missing_fields', 400)

  if (!(await requireMember(env.DB, team_id, auth.userId))) return err('forbidden', 403)

  // Verify agent belongs to team
  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(agent_id, team_id)
    .first<{ id: string }>()
  if (!agent) return err('agent_not_found', 404)

  const taskId = ulid()
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare('INSERT INTO tasks (id, team_id, agent_id, sender_id, subject, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(taskId, team_id, agent_id, auth.userId, subject.trim(), 'pending', now),
    // Insert initial user message — use body if provided, else fall back to subject
    env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(), taskId, auth.userId, 'user', taskBody?.trim() || subject.trim(), now),
  ])

  return json({ id: taskId, status: 'pending' }, 201)
}

export async function closeTask(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  const now = Date.now()

  // Find the currently open session (still status='running' while task is waiting_input)
  const session = await env.DB
    .prepare("SELECT id FROM sessions WHERE task_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
    .bind(taskId)
    .first<{ id: string }>()

  const ops = [
    env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").bind(now, taskId),
  ]
  if (session) {
    ops.push(
      env.DB.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").bind(now, session.id)
    )
  }

  await env.DB.batch(ops)
  return json({ ok: true })
}

export async function deleteTask(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id, agent_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string; agent_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  const now = Date.now()

  // Complete any active session so the daemon receives a cancel signal on next heartbeat
  const activeSession = await env.DB
    .prepare("SELECT id FROM sessions WHERE task_id = ? AND status IN ('running', 'waiting_input') ORDER BY started_at DESC LIMIT 1")
    .bind(taskId)
    .first<{ id: string }>()

  await env.DB.batch([
    // Close active session and reset agent state before deleting
    ...(activeSession ? [
      env.DB.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").bind(now, activeSession.id),
      env.DB.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").bind(task.agent_id),
      env.DB.prepare("UPDATE agent_state SET current_task_id = NULL, current_session = NULL, mode = 'idle', updated_at = ? WHERE agent_id = ?").bind(now, task.agent_id),
    ] : [
      // No active session — still clear any stale FK refs
      env.DB.prepare('UPDATE agent_state SET current_task_id = NULL, current_session = NULL WHERE current_task_id = ?').bind(taskId),
    ]),
    env.DB.prepare('DELETE FROM task_logs WHERE task_id = ?').bind(taskId),
    env.DB.prepare('DELETE FROM messages WHERE task_id = ?').bind(taskId),
    env.DB.prepare('DELETE FROM sessions WHERE task_id = ?').bind(taskId),
    env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(taskId),
  ])
  return json({ ok: true })
}

export async function forwardTask(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const body = await req.json<{ agent_id?: string }>().catch(() => ({} as { agent_id?: string }))
  if (!body.agent_id) return err('agent_id_required', 400)

  const task = await env.DB
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ id: string; team_id: string; agent_id: string; subject: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  // Verify target agent belongs to the same team
  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(body.agent_id, task.team_id)
    .first<{ id: string }>()
  if (!agent) return err('agent_not_found', 404)

  const { results: msgs } = await env.DB
    .prepare(`
      SELECT m.role, m.body, u.email
      FROM messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.task_id = ? ORDER BY m.created_at ASC
    `)
    .bind(taskId)
    .all<{ role: string; body: string; email: string | null }>()

  const history = msgs.map(m => {
    const label = m.role === 'user' ? (m.email ?? 'User') : 'Agent'
    return `[${label}]: ${m.body}`
  }).join('\n\n---\n\n')

  const newId = ulid()
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO tasks (id, team_id, agent_id, sender_id, subject, status, created_at, parent_task_id) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(newId, task.team_id, body.agent_id, auth.userId, task.subject, 'pending', now, taskId),
    env.DB.prepare(
      'INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?,?,?,?,?,?)'
    ).bind(ulid(), newId, auth.userId, 'user', `[Forwarded thread]\n\n${history}`, now),
  ])

  return json({ task_id: newId }, 201)
}

export async function logs(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare('SELECT id, level, body, created_at FROM task_logs WHERE task_id = ? ORDER BY created_at ASC')
    .bind(taskId)
    .all()
  return json({ logs: rows.results })
}

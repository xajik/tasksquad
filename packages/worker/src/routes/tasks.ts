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

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const body = await req.json<{ agent_id?: string; subject?: string; team_id?: string }>().catch(() => ({} as { agent_id?: string; subject?: string; team_id?: string }))
  const { agent_id, subject, team_id } = body
  if (!agent_id || !subject?.trim() || !team_id) return err('missing_fields', 400)

  if (!(await requireMember(env.DB, team_id, auth.userId))) return err('forbidden', 403)

  // Verify agent belongs to team
  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(agent_id, team_id)
    .first<{ id: string }>()
  if (!agent) return err('agent_not_found', 404)

  // Check agent not already busy
  const busy = await env.DB
    .prepare("SELECT id FROM tasks WHERE agent_id = ? AND status IN ('pending', 'running', 'waiting_input')")
    .bind(agent_id)
    .first<{ id: string }>()
  if (busy) return err('agent_busy', 409)

  const taskId = ulid()
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare('INSERT INTO tasks (id, team_id, agent_id, sender_id, subject, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(taskId, team_id, agent_id, auth.userId, subject.trim(), 'pending', now),
    // Insert initial user message
    env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(), taskId, auth.userId, 'user', subject.trim(), now),
  ])

  return json({ id: taskId, status: 'pending' }, 201)
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

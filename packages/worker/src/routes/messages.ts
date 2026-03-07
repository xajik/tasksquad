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
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare('SELECT id, task_id, sender_id, role, body, created_at FROM messages WHERE task_id = ? ORDER BY created_at ASC')
    .bind(taskId)
    .all()
  return json({ messages: rows.results })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id, status, agent_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string; status: string; agent_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  const body = await req.json<{ body?: string }>().catch(() => ({} as { body?: string }))
  const text = body.body?.trim()
  if (!text) return err('body_required', 400)

  const id = ulid()
  const now = Date.now()
  await env.DB
    .prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, taskId, auth.userId, 'user', text, now)
    .run()

  // If task was waiting_input, move it back to pending so daemon picks it up
  if (task.status === 'waiting_input') {
    await env.DB
      .prepare("UPDATE tasks SET status = 'pending' WHERE id = ?")
      .bind(taskId)
      .run()
  }

  return json({ id, role: 'user', body: text, created_at: now }, 201)
}

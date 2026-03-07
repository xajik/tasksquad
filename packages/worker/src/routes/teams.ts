import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const body = await req.json<{ name?: string }>().catch(() => ({} as { name?: string }))
  const name = body.name?.trim()
  if (!name) return err('name_required', 400)

  const teamId = ulid()
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare('INSERT INTO teams (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)')
      .bind(teamId, name, auth.userId, now),
    env.DB.prepare('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .bind(teamId, auth.userId, 'owner', now),
  ])

  return json({ id: teamId, name }, 201)
}

export async function listMembers(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  const member = await env.DB
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, auth.userId)
    .first<{ role: string }>()
  if (!member) return err('not_found', 404)

  const rows = await env.DB
    .prepare(`
      SELECT u.id, u.email, tm.role, tm.joined_at
      FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ?
      ORDER BY tm.joined_at ASC
    `)
    .bind(teamId)
    .all<{ id: string; email: string; role: string; joined_at: number }>()

  return json({ members: rows.results })
}

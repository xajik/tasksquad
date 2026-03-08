import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'

export async function list(_req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const rows = await env.DB
    .prepare(`
      SELECT DISTINCT t.id, t.name, tm.role
      FROM teams t JOIN team_members tm ON t.id = tm.team_id
      WHERE tm.user_id = ? AND t.is_deactivated = 0
      ORDER BY t.created_at DESC
    `)
    .bind(auth.userId)
    .all<{ id: string; name: string; role: string }>()

  return json({ teams: rows.results })
}

export async function deactivate(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  const member = await env.DB
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, auth.userId)
    .first<{ role: string }>()
  
  if (!member || member.role !== 'owner') {
    return err('unauthorized', 403)
  }

  // Get all active agent IDs for this team to signal them to cancel
  const agents = await env.DB
    .prepare('SELECT id FROM agents WHERE team_id = ?')
    .bind(teamId)
    .all<{ id: string }>()

  // 1. Mark team as deactivated
  // 2. Mark all pending/running tasks for this team as failed
  // 3. Mark all agents as offline
  const now = Date.now()
  const ops = [
    env.DB.prepare('UPDATE teams SET is_deactivated = 1 WHERE id = ?').bind(teamId),
    env.DB.prepare("UPDATE tasks SET status = 'failed' WHERE team_id = ? AND status IN ('pending', 'running', 'waiting_input')").bind(teamId),
    env.DB.prepare("UPDATE agents SET status = 'offline' WHERE team_id = ?").bind(teamId),
    env.DB.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE task_id IN (SELECT id FROM tasks WHERE team_id = ?) AND status IN ('running', 'waiting_input')").bind(now, teamId),
  ]
  await env.DB.batch(ops)

  // Signal all active agents in this team to cancel current tasks
  for (const agent of agents.results) {
    const doId = env.AGENT_RELAY.idFromName(agent.id)
    const stub = env.AGENT_RELAY.get(doId)
    // We don't have a direct 'cancel' method on DO, but heartbeat will pick it up
    // because task status is now 'failed'. We can also push a 'done' event.
    await stub.fetch(new Request('https://relay/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'done', lines: ['Team deactivated. Task cancelled.'] }),
    })).catch(() => {})
  }

  return json({ ok: true })
}

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

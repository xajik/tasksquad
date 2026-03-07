import { ulid } from 'ulidx'
import { json, err, sha256 } from '../auth.js'
import type { Env, AuthContext } from '../types.js'

async function requireMaintainer(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ? AND role IN ('owner', 'maintainer')")
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

async function requireMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare('SELECT id, name, command, work_dir, status, last_seen, created_at FROM agents WHERE team_id = ? ORDER BY created_at ASC')
    .bind(teamId)
    .all<{ id: string; name: string; command: string; work_dir: string; status: string; last_seen: number | null; created_at: number }>()

  return json({ agents: rows.results })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  if (!(await requireMaintainer(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const body = await req.json<{ name?: string; command?: string; work_dir?: string }>().catch(() => ({} as { name?: string; command?: string; work_dir?: string }))
  const { name, command, work_dir } = body
  if (!name?.trim() || !command?.trim() || !work_dir?.trim()) return err('missing_fields', 400)

  // Check name uniqueness within team
  const existing = await env.DB
    .prepare('SELECT id FROM agents WHERE team_id = ? AND name = ?')
    .bind(teamId, name.trim())
    .first<{ id: string }>()
  if (existing) return err('name_taken', 409)

  const id = ulid()
  const now = Date.now()
  await env.DB
    .prepare('INSERT INTO agents (id, team_id, name, command, work_dir, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, teamId, name.trim(), command.trim(), work_dir.trim(), 'offline', now)
    .run()

  // Initialise agent_state row
  await env.DB
    .prepare('INSERT INTO agent_state (agent_id, mode, viewer_count, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, 'idle', 0, now)
    .run()

  return json({ id, name: name.trim(), status: 'offline' }, 201)
}

export async function createToken(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  if (!(await requireMaintainer(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const body = await req.json<{ label?: string; agent_id?: string }>().catch(() => ({} as { label?: string; agent_id?: string }))
  const label = body.label?.trim() || 'Unnamed'
  const agentId = body.agent_id

  // Verify agent belongs to this team (if provided)
  if (agentId) {
    const agent = await env.DB
      .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
      .bind(agentId, teamId)
      .first<{ id: string }>()
    if (!agent) return err('agent_not_found', 404)
  }

  const rawBytes = crypto.getRandomValues(new Uint8Array(32))
  const rawHex = Array.from(rawBytes).map(b => b.toString(16).padStart(2, '0')).join('')
  const rawToken = `tsq_${rawHex}`

  const hash = await sha256(rawToken)
  const id = ulid()
  const now = Date.now()

  await env.DB
    .prepare('INSERT INTO daemon_tokens (id, team_id, agent_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, teamId, agentId ?? null, hash, label, now)
    .run()

  return json({ id, token: rawToken, label }, 201)
}

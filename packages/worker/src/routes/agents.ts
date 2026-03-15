import { ulid } from 'ulidx'
import { json, err, sha256 } from '../auth.js'
import type { Env, AuthContext } from '../types.js'
import { generateDEK, wrapDEK, importMasterKey } from '../crypto.js'

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
    .prepare('SELECT id, name, role, status, last_seen, created_at, paused, reset_pending FROM agents WHERE team_id = ? ORDER BY created_at ASC')
    .bind(teamId)
    .all<{ id: string; name: string; role: string | null; status: string; last_seen: number | null; created_at: number; paused: number; reset_pending: number }>()

  return json({ agents: rows.results })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  if (!(await requireMaintainer(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const body = await req.json<{ name?: string; role?: string }>().catch(() => ({} as { name?: string; role?: string }))
  const { name, role } = body
  if (!name?.trim()) return err('missing_fields', 400)

  // Check name uniqueness within team
  const existing = await env.DB
    .prepare('SELECT id FROM agents WHERE team_id = ? AND name = ?')
    .bind(teamId, name.trim())
    .first<{ id: string }>()
  if (existing) return err('name_taken', 409)

  // Generate and wrap a unique Data Encryption Key (DEK) for this agent
  let encryptedDek: string | null = null
  if (env.R2_LOGS_MASTER_KEY) {
    try {
      const dek = await generateDEK()
      const masterKey = await importMasterKey(env.R2_LOGS_MASTER_KEY)
      encryptedDek = await wrapDEK(dek, masterKey)
    } catch (e) {
      console.error(`[agents/create] encryption setup failed: ${e}`)
      // Fall back to unencrypted for now if setup fails
    }
  }

  const id = ulid()
  const now = Date.now()
  await env.DB
    .prepare('INSERT INTO agents (id, team_id, name, role, status, created_at, encrypted_dek) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, teamId, name.trim(), role?.trim() || null, 'offline', now, encryptedDek)
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
  const expiresAt = now + 90 * 24 * 60 * 60 * 1000 // 90 days

  await env.DB
    .prepare('INSERT INTO daemon_tokens (id, team_id, agent_id, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, teamId, agentId ?? null, hash, label, now, expiresAt)
    .run()

  return json({ id, token: rawToken, label }, 201)
}

export async function resetAgent(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const agentId = parts[4]

  if (!(await requireMaintainer(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(agentId, teamId)
    .first<{ id: string }>()
  if (!agent) return err('not_found', 404)

  const now = Date.now()

  await env.DB.batch([
    // Signal daemon to reset on next heartbeat
    env.DB.prepare('UPDATE agents SET reset_pending = 1 WHERE id = ?').bind(agentId),
    // Complete in-progress tasks (not re-queued — they are done)
    env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE agent_id = ? AND status IN ('running', 'waiting_input')")
      .bind(now, agentId),
    // Close any open sessions
    env.DB.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE agent_id = ? AND status IN ('running', 'waiting_input')")
      .bind(now, agentId),
    // Clear agent_state current task/session; daemon will update mode to idle on its next heartbeat
    env.DB.prepare("UPDATE agent_state SET current_task_id = NULL, current_session = NULL, updated_at = ? WHERE agent_id = ?")
      .bind(now, agentId),
  ])

  return json({ ok: true })
}

export async function pauseAgent(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const agentId = parts[4]

  if (!(await requireMaintainer(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(agentId, teamId)
    .first<{ id: string }>()
  if (!agent) return err('not_found', 404)

  const body = await req.json<{ paused?: boolean }>().catch(() => ({} as { paused?: boolean }))
  const paused = body.paused === true ? 1 : 0

  await env.DB.prepare('UPDATE agents SET paused = ? WHERE id = ?').bind(paused, agentId).run()

  return json({ ok: true, paused: !!paused })
}

export async function updateAgent(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const agentId = parts[4]

  if (!(await requireMaintainer(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(agentId, teamId)
    .first<{ id: string }>()
  if (!agent) return err('not_found', 404)

  const body = await req.json<{ role?: string }>().catch(() => ({} as { role?: string }))
  const role = body.role?.trim() ?? null

  await env.DB.prepare('UPDATE agents SET role = ? WHERE id = ?').bind(role, agentId).run()

  return json({ ok: true, role })
}

export async function deleteAgent(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const agentId = parts[4]

  if (!(await requireMaintainer(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(agentId, teamId)
    .first<{ id: string }>()
  if (!agent) return err('not_found', 404)

  // Cascade delete: tokens → state → sessions → messages (via tasks) → tasks → agent
  const taskIds = await env.DB
    .prepare('SELECT id FROM tasks WHERE agent_id = ?')
    .bind(agentId)
    .all<{ id: string }>()
  const ids = taskIds.results.map(r => r.id)

  // Clear agent_state FK refs to sessions/tasks first, then delete in dependency order:
  // task_logs → sessions → messages → tasks → agent_state → daemon_tokens → agents
  const ops = [
    env.DB.prepare('UPDATE agent_state SET current_task_id = NULL, current_session = NULL WHERE agent_id = ?').bind(agentId),
  ]
  for (const taskId of ids) {
    ops.push(env.DB.prepare('DELETE FROM task_logs WHERE task_id = ?').bind(taskId))
    ops.push(env.DB.prepare('DELETE FROM messages WHERE task_id = ?').bind(taskId))
  }
  ops.push(env.DB.prepare('DELETE FROM sessions WHERE agent_id = ?').bind(agentId))
  ops.push(env.DB.prepare('DELETE FROM tasks WHERE agent_id = ?').bind(agentId))
  ops.push(env.DB.prepare('DELETE FROM agent_state WHERE agent_id = ?').bind(agentId))
  ops.push(env.DB.prepare('DELETE FROM daemon_tokens WHERE agent_id = ?').bind(agentId))
  ops.push(env.DB.prepare('DELETE FROM agents WHERE id = ?').bind(agentId))

  await env.DB.batch(ops)
  return json({ ok: true })
}

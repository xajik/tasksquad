import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import { bumpInboxVersion } from '../inbox_version.js'
import { requireMember } from './helpers.js'
import type { Env, AuthContext, DaemonContext } from '../types.js'

// ── Browser routes ────────────────────────────────────────────────────────────

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.searchParams.get('team_id')
  if (!teamId) return err('team_id_required', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare(`
      SELECT id, team_id, agent_id, sender_id, status, session_id, created_at, started_at, completed_at
      FROM portals
      WHERE team_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `)
    .bind(teamId)
    .all()

  return json({ portals: rows.results })
}

export async function get(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const portalId = new URL(req.url).pathname.split('/')[2]

  const portal = await env.DB
    .prepare('SELECT id, team_id, agent_id, sender_id, status, session_id, created_at, started_at, completed_at FROM portals WHERE id = ?')
    .bind(portalId)
    .first<{ id: string; team_id: string; agent_id: string; sender_id: string; status: string; session_id: string | null; created_at: number; started_at: number | null; completed_at: number | null }>()

  if (!portal) return err('not_found', 404)
  if (!(await requireMember(env.DB, portal.team_id, auth.userId))) return err('not_found', 404)

  return json(portal)
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const body = await req.json<{ team_id?: string; agent_id?: string }>().catch(() => ({} as { team_id?: string; agent_id?: string }))
  const { team_id, agent_id } = body
  if (!team_id || !agent_id) return err('missing_fields', 400)
  if (!(await requireMember(env.DB, team_id, auth.userId))) return err('forbidden', 403)

  // Only paid users can create portals — plan is already on auth from withFirebaseAuth
  if (auth.plan !== 'pro') return err('plan_required', 403)

  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(agent_id, team_id)
    .first<{ id: string }>()
  if (!agent) return err('agent_not_found', 404)

  // Enforce team limit of 3 live portals atomically (single INSERT with WHERE guard
  // avoids TOCTOU race between separate COUNT and INSERT statements).
  const id = ulid()
  const now = Date.now()
  const insertResult = await env.DB
    .prepare(`
      INSERT INTO portals (id, team_id, agent_id, sender_id, status, created_at)
      SELECT ?, ?, ?, ?, 'pending', ?
      WHERE (SELECT COUNT(*) FROM portals WHERE team_id = ? AND status IN ('pending', 'running')) < 3
    `)
    .bind(id, team_id, agent_id, auth.userId, now, team_id)
    .run()
  if (!insertResult.meta.changes) return err('portal_limit_reached', 429)

  // Invalidate the combined ETag so the daemon picks up the portal on its next heartbeat
  // even when it was returning 304 (all agents idle, nothing else changed).
  await bumpInboxVersion(env, agent_id)

  return json({ id, status: 'pending' }, 201)
}

// Close a live portal from the browser — immediately marks done and signals
// the daemon on its next heartbeat to kill the tmux session.
export async function browserClose(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const portalId = new URL(req.url).pathname.split('/')[2]

  const portal = await env.DB
    .prepare('SELECT id, team_id, agent_id, status FROM portals WHERE id = ?')
    .bind(portalId)
    .first<{ id: string; team_id: string; agent_id: string; status: string }>()
  if (!portal) return err('not_found', 404)
  if (!(await requireMember(env.DB, portal.team_id, auth.userId))) return err('forbidden', 403)

  if (portal.status === 'done' || portal.status === 'failed') {
    return json({ ok: true }) // already terminal, no-op
  }

  const now = Date.now()
  await env.DB
    .prepare(`UPDATE portals SET status = 'done', completed_at = ? WHERE id = ? AND status NOT IN ('done', 'failed')`)
    .bind(now, portal.id)
    .run()

  // Signal daemon on next heartbeat to kill the tmux session
  await bumpInboxVersion(env, portal.agent_id)

  return json({ ok: true })
}

// ── Daemon routes ─────────────────────────────────────────────────────────────

// Called by daemon on next heartbeat to claim a pending portal.
// Returns the oldest pending portal for this agent, or null.
export async function daemonPoll(_req: Request, env: Env, _ctx: unknown, d: DaemonContext): Promise<Response> {
  const portal = await env.DB
    .prepare(`
      SELECT id, team_id, agent_id, sender_id, status, created_at
      FROM portals
      WHERE agent_id = ? AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `)
    .bind(d.agentId)
    .first<{ id: string; team_id: string; agent_id: string; sender_id: string; status: string; created_at: number }>()

  return json({ portal: portal ?? null })
}

// Called by daemon when it has opened a tmux session for the portal.
export async function daemonOpen(req: Request, env: Env, _ctx: unknown, d: DaemonContext): Promise<Response> {
  const body = await req.json<{ portal_id?: string; session_id?: string }>().catch(() => ({} as { portal_id?: string; session_id?: string }))
  if (!body.portal_id || !body.session_id) return err('missing_fields', 400)

  const portal = await env.DB
    .prepare(`SELECT id, agent_id FROM portals WHERE id = ? AND status = 'pending'`)
    .bind(body.portal_id)
    .first<{ id: string; agent_id: string }>()
  if (!portal) return err('not_found', 404)
  if (portal.agent_id !== d.agentId) return err('forbidden', 403)

  const now = Date.now()
  await env.DB
    .prepare('UPDATE portals SET status = ?, session_id = ?, started_at = ? WHERE id = ?')
    .bind('running', body.session_id, now, body.portal_id)
    .run()

  return json({ ok: true })
}

// Called by daemon when the tmux session ends (naturally or via close signal).
export async function daemonClose(req: Request, env: Env, _ctx: unknown, d: DaemonContext): Promise<Response> {
  const body = await req.json<{ portal_id?: string; status?: 'done' | 'failed' }>().catch(() => ({} as { portal_id?: string; status?: 'done' | 'failed' }))
  if (!body.portal_id) return err('missing_fields', 400)

  const portal = await env.DB
    .prepare('SELECT id, agent_id FROM portals WHERE id = ?')
    .bind(body.portal_id)
    .first<{ id: string; agent_id: string }>()
  if (!portal) return err('not_found', 404)
  if (portal.agent_id !== d.agentId) return err('forbidden', 403)

  const now = Date.now()
  const finalStatus = body.status === 'failed' ? 'failed' : 'done'
  await env.DB
    .prepare(`UPDATE portals SET status = ?, completed_at = ? WHERE id = ? AND status NOT IN ('done', 'failed')`)
    .bind(finalStatus, now, body.portal_id)
    .run()

  return json({ ok: true })
}

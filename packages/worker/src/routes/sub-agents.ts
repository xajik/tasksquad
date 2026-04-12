import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'
import { requireMember, contentEtag } from './helpers.js'

// ─── Browser Routes ───────────────────────────────────────────────────────────

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare(`
      SELECT id, team_id, name, description, author_id, etag, is_default, auto_install, version, created_at, updated_at
      FROM sub_agents
      WHERE team_id = ? OR is_default = 1
      ORDER BY is_default ASC, name ASC
    `)
    .bind(teamId)
    .all()

  return json({ sub_agents: rows.results })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const body = await req.json<{ name: string; description: string; content: string; auto_install?: boolean }>()
  const { name, description, content, auto_install } = body
  if (!name || !content) return err('missing_fields', 400)

  const now = Date.now()
  const etag = await contentEtag(content)
  const autoInstallVal = auto_install ? 1 : 0

  const existing = await env.DB
    .prepare('SELECT id, version FROM sub_agents WHERE team_id = ? AND name = ?')
    .bind(teamId, name)
    .first<{ id: string; version: number }>()

  if (existing) {
    await env.DB
      .prepare(`
        UPDATE sub_agents SET
          description = ?,
          content     = ?,
          author_id   = ?,
          etag        = ?,
          auto_install = ?,
          version     = version + 1,
          updated_at  = ?
        WHERE id = ?
      `)
      .bind(description ?? '', content, auth.userId, etag, autoInstallVal, now, existing.id)
      .run()
    return json({ id: existing.id, name, etag, version: existing.version + 1 }, 200)
  }

  const id = ulid()
  await env.DB
    .prepare(`
      INSERT INTO sub_agents (id, team_id, name, description, content, author_id, etag, is_default, auto_install, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)
    `)
    .bind(id, teamId, name, description ?? '', content, auth.userId, etag, autoInstallVal, now, now)
    .run()

  return json({ id, name, etag, version: 1 }, 201)
}

export async function get(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const subAgentId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const agent = await env.DB
    .prepare('SELECT * FROM sub_agents WHERE id = ? AND (team_id = ? OR is_default = 1)')
    .bind(subAgentId, teamId)
    .first()

  if (!agent) return err('not_found', 404)
  return json(agent)
}

export async function update(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const subAgentId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const existing = await env.DB
    .prepare('SELECT id, is_default, team_id FROM sub_agents WHERE id = ?')
    .bind(subAgentId)
    .first<{ id: string; is_default: number; team_id: string | null }>()
  if (!existing) return err('not_found', 404)
  if (existing.is_default) return err('cannot_modify_default', 403)
  if (existing.team_id !== teamId) return err('not_found', 404)

  const body = await req.json<{ name?: string; description?: string; content?: string; auto_install?: boolean }>()
  const now = Date.now()

  let etag: string | undefined
  if (body.content !== undefined) {
    etag = await contentEtag(body.content)
  }

  await env.DB
    .prepare(`
      UPDATE sub_agents
      SET name         = coalesce(?, name),
          description  = coalesce(?, description),
          content      = coalesce(?, content),
          etag         = coalesce(?, etag),
          auto_install = coalesce(?, auto_install),
          version      = CASE WHEN ? IS NOT NULL THEN version + 1 ELSE version END,
          updated_at   = ?
      WHERE id = ?
    `)
    .bind(
      body.name ?? null,
      body.description ?? null,
      body.content ?? null,
      etag ?? null,
      body.auto_install !== undefined ? (body.auto_install ? 1 : 0) : null,
      body.content ?? null,
      now,
      subAgentId,
    )
    .run()

  return json({ ok: true })
}

export async function remove(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const subAgentId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const existing = await env.DB
    .prepare('SELECT is_default, team_id FROM sub_agents WHERE id = ?')
    .bind(subAgentId)
    .first<{ is_default: number; team_id: string | null }>()
  if (!existing) return err('not_found', 404)
  if (existing.is_default) return err('cannot_delete_default', 403)
  if (existing.team_id !== teamId) return err('not_found', 404)

  await env.DB.prepare('DELETE FROM sub_agents WHERE id = ?').bind(subAgentId).run()
  return new Response(null, { status: 204 })
}

// ─── Daemon Routes ────────────────────────────────────────────────────────────

// GET /daemon/user/sub-agents?agent_id=XXX
export async function userSubAgents(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.searchParams.get('agent_id')
  if (!agentId) return err('agent_id_required', 400)

  const agent = await env.DB
    .prepare('SELECT team_id FROM agents WHERE id = ?')
    .bind(agentId)
    .first<{ team_id: string }>()
  if (!agent) return err('not_found', 404)

  const teamId = agent.team_id
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare(`
      SELECT id, team_id, name, description, author_id, etag, is_default, auto_install, version, created_at, updated_at
      FROM sub_agents
      WHERE (team_id = ? AND auto_install = 1) OR is_default = 1
      ORDER BY is_default ASC, name ASC
    `)
    .bind(teamId)
    .all()

  return json({ sub_agents: rows.results })
}

// GET /daemon/sub-agents/:subAgentId
export async function daemonSubAgentGet(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const subAgentId = url.pathname.split('/').pop() ?? ''
  if (!subAgentId) return err('sub_agent_id_required', 400)

  const agent = await env.DB
    .prepare('SELECT * FROM sub_agents WHERE id = ?')
    .bind(subAgentId)
    .first<Record<string, unknown> & { team_id: string | null; is_default: number; etag: string }>()

  if (!agent) return err('not_found', 404)

  if (!agent.is_default) {
    if (!agent.team_id) return err('not_found', 404)
    if (!(await requireMember(env.DB, agent.team_id as string, auth.userId))) return err('not_found', 404)
  }

  const ifNoneMatch = req.headers.get('If-None-Match')
  if (ifNoneMatch && ifNoneMatch === agent.etag) {
    return new Response(null, { status: 304 })
  }

  return json(agent)
}

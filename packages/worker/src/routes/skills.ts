import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext, DaemonContext } from '../types.js'

async function requireMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

async function contentEtag(content: string): Promise<string> {
  const enc = new TextEncoder()
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(content))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ─── Skills ──────────────────────────────────────────────────────────────────

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2] // /teams/:teamId/skills

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare(`
      SELECT id, team_id, name, description, author_id, etag, is_default, auto_install, created_at, updated_at
      FROM skills
      WHERE team_id = ? OR is_default = 1
      ORDER BY is_default ASC, name ASC
    `)
    .bind(teamId)
    .all()

  return json({ skills: rows.results })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const body = await req.json<{ name: string; description: string; content: string; auto_install?: boolean }>()
  const { name, description, content, auto_install } = body
  if (!name || !content) return err('missing_fields', 400)

  const id = ulid()
  const now = Date.now()
  const etag = await contentEtag(content)
  const autoInstallVal = auto_install ? 1 : 0

  // Upsert: if name exists for this team, update it
  await env.DB
    .prepare(`
      INSERT INTO skills (id, team_id, name, description, content, author_id, etag, is_default, auto_install, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)
      ON CONFLICT(team_id, name) DO UPDATE SET
        description  = excluded.description,
        content      = excluded.content,
        author_id    = excluded.author_id,
        etag         = excluded.etag,
        auto_install = excluded.auto_install,
        version      = version + 1,
        updated_at   = excluded.updated_at
    `)
    .bind(id, teamId, name, description ?? '', content, auth.userId, etag, autoInstallVal, now, now)
    .run()

  const row = await env.DB
    .prepare('SELECT id, version FROM skills WHERE team_id = ? AND name = ?')
    .bind(teamId, name)
    .first<{ id: string; version: number }>()

  return json({ id: row?.id ?? id, name, etag, version: row?.version ?? 1 }, 201)
}

export async function get(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const skillId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const skill = await env.DB
    .prepare('SELECT * FROM skills WHERE id = ? AND (team_id = ? OR is_default = 1)')
    .bind(skillId, teamId)
    .first()

  if (!skill) return err('not_found', 404)
  return json(skill)
}

export async function update(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const skillId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const existing = await env.DB
    .prepare('SELECT id, is_default, team_id FROM skills WHERE id = ?')
    .bind(skillId)
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
      UPDATE skills
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
      body.content ?? null, // drives version increment — only bumps when content changes
      now,
      skillId,
    )
    .run()

  return json({ ok: true })
}

export async function remove(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const skillId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const existing = await env.DB
    .prepare('SELECT is_default, team_id FROM skills WHERE id = ?')
    .bind(skillId)
    .first<{ is_default: number; team_id: string | null }>()
  if (!existing) return err('not_found', 404)
  if (existing.is_default) return err('cannot_delete_default', 403)
  if (existing.team_id !== teamId) return err('not_found', 404)

  await env.DB.prepare('DELETE FROM skills WHERE id = ?').bind(skillId).run()
  return new Response(null, { status: 204 })
}

// ─── Daemon list (for sync) ───────────────────────────────────────────────────

// GET /daemon/user/skills?agent_id=XXX
// Returns auto_install skills + default skills for the agent's team.
// Uses Firebase auth (called by daemon's hourly sync via api.Get).
export async function userSkills(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.searchParams.get('agent_id')
  if (!agentId) return err('agent_id_required', 400)

  // Resolve teamId from agentId
  const agent = await env.DB
    .prepare('SELECT team_id FROM agents WHERE id = ?')
    .bind(agentId)
    .first<{ team_id: string }>()
  if (!agent) return err('not_found', 404)

  const teamId = agent.team_id
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare(`
      SELECT id, team_id, name, description, author_id, etag, is_default, auto_install, created_at, updated_at
      FROM skills
      WHERE (team_id = ? AND auto_install = 1) OR is_default = 1
      ORDER BY is_default ASC, name ASC
    `)
    .bind(teamId)
    .all()

  return json({ skills: rows.results })
}

// ─── Daemon upsert ─────────────────────────────────────────────────────────────

export async function daemonUpsert(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{ name: string; description?: string; content: string }>()
  const { name, description, content } = body

  if (!name || !content) return err('missing_fields', 400)
  if (!name.startsWith('tsq-')) return err('name_must_start_with_tsq', 400)

  const { teamId, agentId } = daemon
  const id = ulid()
  const now = Date.now()
  const etag = await contentEtag(content)

  await env.DB
    .prepare(`
      INSERT INTO skills (id, team_id, name, description, content, author_id, etag, is_default, auto_install, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 1, ?, ?)
      ON CONFLICT(team_id, name) DO UPDATE SET
        description = excluded.description,
        content     = excluded.content,
        etag        = excluded.etag,
        version     = version + 1,
        updated_at  = excluded.updated_at
    `)
    .bind(id, teamId, name, description ?? '', content, etag, now, now)
    .run()

  const row = await env.DB
    .prepare('SELECT id, version FROM skills WHERE team_id = ? AND name = ?')
    .bind(teamId, name)
    .first<{ id: string; version: number }>()

  return json({ id: row?.id ?? id, name, etag, version: row?.version ?? 1, agent_id: agentId }, 201)
}

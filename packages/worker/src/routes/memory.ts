import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext, DaemonContext } from '../types.js'
import { requireMember } from './helpers.js'

// ─── Memory ──────────────────────────────────────────────────────────────────
// Global-scope only — local-scope memory lives in the daemon's <work_dir>/.tsq/memory/
// and never reaches this route file. See 0039_memory.sql.

const MEMORY_CATEGORIES = ['personal', 'preferences', 'structure', 'architecture', 'events'] as const
type MemoryCategory = typeof MEMORY_CATEGORIES[number]

function isValidCategory(category: unknown): category is MemoryCategory {
  return typeof category === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(category)
}

const MAX_TAGS_PER_TEAM = 1000
const MAX_TAG_LENGTH = 30

function isValidTag(tag: unknown): tag is string {
  return typeof tag === 'string' && tag.length > 0 && tag.length <= MAX_TAG_LENGTH && !/\s/.test(tag)
}

// Resolves a tag name to its id, creating it if needed. Enforces the 1000-tags-per-team
// cap with a single atomic INSERT...WHERE guard (see portals.ts's live-portal-limit guard
// for the same pattern) instead of a racy count-then-insert. Returns an error Response if
// the tag is new and the team is already at the cap.
async function upsertTag(db: D1Database, teamId: string, name: string, now: number): Promise<string | Response> {
  const existing = await db.prepare('SELECT id FROM tags WHERE team_id = ? AND name = ?').bind(teamId, name).first<{ id: string }>()
  if (existing) return existing.id

  const id = ulid()
  try {
    const insertResult = await db
      .prepare(`
        INSERT INTO tags (id, team_id, name, created_at)
        SELECT ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM tags WHERE team_id = ?) < ?
      `)
      .bind(id, teamId, name, now, teamId, MAX_TAGS_PER_TEAM)
      .run()
    if (!insertResult.meta.changes) return err('tag_limit_reached', 429)
    return id
  } catch {
    // Lost a race to create the same tag concurrently — use the winner's row.
    const raced = await db.prepare('SELECT id FROM tags WHERE team_id = ? AND name = ?').bind(teamId, name).first<{ id: string }>()
    if (raced) return raced.id
    return err('tag_limit_reached', 429)
  }
}

// ─── Browser routes ────────────────────────────────────────────────────────────

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2] // /teams/:teamId/memory

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const category = url.searchParams.get('category')
  if (category && !isValidCategory(category)) return err('invalid_category', 400)

  const rows = await env.DB
    .prepare(`
      SELECT m.id, m.team_id, m.agent_id, m.category, m.title, m.content, m.created_at, m.updated_at,
             json_group_array(t.name) FILTER (WHERE t.name IS NOT NULL) as tags
      FROM memory m
      LEFT JOIN memory_tags mt ON m.id = mt.memory_id
      LEFT JOIN tags t ON mt.tag_id = t.id
      WHERE m.team_id = ? AND (? IS NULL OR m.category = ?)
      GROUP BY m.id
      ORDER BY m.created_at DESC
      LIMIT 100
    `)
    .bind(teamId, category, category)
    .all()

  const results = rows.results.map((m: any) => ({ ...m, tags: JSON.parse(m.tags || '[]') }))
  return json({ memory: results })
}

export async function get(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const memoryId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const row = await env.DB
    .prepare(`
      SELECT m.*, json_group_array(t.name) FILTER (WHERE t.name IS NOT NULL) as tags
      FROM memory m
      LEFT JOIN memory_tags mt ON m.id = mt.memory_id
      LEFT JOIN tags t ON mt.tag_id = t.id
      WHERE m.id = ? AND m.team_id = ?
      GROUP BY m.id
    `)
    .bind(memoryId, teamId)
    .first<any>()

  if (!row) return err('not_found', 404)

  row.tags = JSON.parse(row.tags || '[]')
  return json(row)
}

// GET /teams/:teamId/rollups?period=daily|weekly — daily/weekly memory_rollup
// snapshots for the Portal's "Daily" tab, newest period_key first. period_key is
// 'YYYY-MM-DD' (daily) or 'YYYY-Www' (weekly) — both lexicographically sortable,
// so ORDER BY period_key DESC is correct without parsing dates. See
// packages/worker/src/cron/rollup.ts for how these rows get written.
export async function rollups(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2] // /teams/:teamId/rollups

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const period = url.searchParams.get('period') === 'weekly' ? 'weekly' : 'daily'

  const rows = await env.DB
    .prepare('SELECT id, team_id, period, period_key, content, created_at FROM memory_rollup WHERE team_id = ? AND period = ? ORDER BY period_key DESC LIMIT 60')
    .bind(teamId, period)
    .all()

  return json({ rollups: rows.results })
}

// GET /daemon/memory/rollup?period=daily — daemon-facing variant of rollups() above,
// used by Dreaming to fetch "today's changes in Memory" as its entire prompt input.
// Same query, swapping requireMember+URL teamId for the authenticated DaemonContext
// (same substitution as list -> daemonPush in this file). Returns only the single
// latest period's content, not the full history rollups() gives the Portal.
export async function daemonRollup(req: Request, env: Env, _ctx: unknown, d: DaemonContext): Promise<Response> {
  const url = new URL(req.url)
  const period = url.searchParams.get('period') === 'weekly' ? 'weekly' : 'daily'

  const row = await env.DB
    .prepare('SELECT content, period_key FROM memory_rollup WHERE team_id = ? AND period = ? ORDER BY period_key DESC LIMIT 1')
    .bind(d.teamId, period)
    .first<{ content: string; period_key: string }>()

  return json({ content: row?.content ?? '', period_key: row?.period_key ?? null })
}

// ─── Daemon routes ─────────────────────────────────────────────────────────────

// POST /daemon/memory — pushed by `tsq memory push --scope global` at session close.
// Mirrors daemonUpsert in skills.ts: daemonRoute-wrapped, team/agent identity comes
// from the authenticated DaemonContext, never from the request body.
export async function daemonPush(req: Request, env: Env, _ctx: unknown, d: DaemonContext): Promise<Response> {
  const body = await req.json<{ category?: string; title?: string; content?: string; tags?: string[] }>().catch(() => ({} as { category?: string; title?: string; content?: string; tags?: string[] }))
  const { category, title, content, tags } = body

  if (!title?.trim() || !content?.trim()) return err('missing_fields', 400)
  if (!isValidCategory(category)) return err('invalid_category', 400)

  const tagNames = tags ?? []
  for (const tag of tagNames) {
    if (!isValidTag(tag)) return err('invalid_tag', 400)
  }

  const { teamId, agentId } = d
  const now = Date.now()

  // Resolve/create tags before writing the memory row, so a tag-limit rejection
  // doesn't leave behind a memory entry with only some of its tags linked.
  const tagIds: string[] = []
  for (const tagName of tagNames) {
    const result = await upsertTag(env.DB, teamId, tagName, now)
    if (result instanceof Response) return result
    tagIds.push(result)
  }

  const id = ulid()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO memory (id, team_id, agent_id, category, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, teamId, agentId, category, title.trim(), content, now, now),
    ...tagIds.map(tagId =>
      env.DB.prepare('INSERT INTO memory_tags (memory_id, tag_id) VALUES (?, ?)').bind(id, tagId)
    ),
  ])

  return json({ id, category, title: title.trim(), created_at: now, updated_at: now, agent_id: agentId, tags: tagNames }, 201)
}

// GET /daemon/memory/search?q=&team_id= — used by `tsq memory search`. The team_id
// query param exists for documentation symmetry with the CLI call but is never
// trusted — scope always comes from the authenticated agent's team (d.teamId),
// same as every other daemonRoute-wrapped handler.
export async function search(req: Request, env: Env, _ctx: unknown, d: DaemonContext): Promise<Response> {
  const url = new URL(req.url)
  const q = url.searchParams.get('q')?.trim()
  if (!q) return err('q_required', 400)

  const like = `%${q}%`
  const rows = await env.DB
    .prepare(`
      SELECT DISTINCT m.id, m.team_id, m.agent_id, m.category, m.title, m.content, m.created_at, m.updated_at
      FROM memory m
      LEFT JOIN memory_tags mt ON m.id = mt.memory_id
      LEFT JOIN tags t ON mt.tag_id = t.id
      WHERE m.team_id = ? AND (m.title LIKE ? OR m.content LIKE ? OR t.name LIKE ?)
      ORDER BY m.created_at DESC
      LIMIT 50
    `)
    .bind(d.teamId, like, like, like)
    .all()

  return json({ memory: rows.results })
}

import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'
import { requireMember } from './helpers.js'

// ─── Tags ────────────────────────────────────────────────────────────────────
// The `tags` table (0017_notes.sql) is shared across notes and memory — one tag
// universe per team. This is the only listing endpoint for it; notes and memory
// otherwise only ever return tags embedded in their own payloads.

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2] // /teams/:teamId/tags

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare('SELECT id, team_id, name, created_at FROM tags WHERE team_id = ? ORDER BY name ASC')
    .bind(teamId)
    .all()

  return json({ tags: rows.results })
}

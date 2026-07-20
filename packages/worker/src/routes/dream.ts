import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, DaemonContext } from '../types.js'

// ─── Dreaming ──────────────────────────────────────────────────────────────────
// Dreaming's actual content transport is git, not this worker (see 0041_dream_runs.sql's
// header comment) — the only thing this route coordinates is which daemon gets to run
// the nightly job for a given project, so at most one daemon dreams a given git repo
// per team per night even when multiple teammates' machines are watching the same repo.

const MAX_PROJECT_KEY_LENGTH = 500
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

// POST /daemon/dream/claim — called by the Dreamer once it's past its randomized
// per-project trigger time for tonight. First daemon to insert for a given
// (team_id, project_key, date) wins the claim; every other daemon's insert hits
// idx_dream_runs_claim (UNIQUE(team_id, project_key, date)) and gets {claimed: false}.
// Unlike upsertTag (memory.ts), there's no pre-check-then-insert here — a lost race
// is the expected, common case (that's the whole point of the table), so we just
// attempt the insert and read the outcome from whether it threw.
export async function claim(req: Request, env: Env, _ctx: unknown, d: DaemonContext): Promise<Response> {
  const body = await req.json<{ project_key?: string; date?: string }>().catch(() => ({} as { project_key?: string; date?: string }))
  const { project_key, date } = body

  if (!project_key?.trim() || !date?.trim()) return err('missing_fields', 400)
  if (!DATE_SHAPE.test(date.trim())) return err('invalid_date', 400)
  if (project_key.trim().length > MAX_PROJECT_KEY_LENGTH) return err('invalid_project_key', 400)

  const { teamId, agentId } = d
  const id = ulid()

  try {
    await env.DB
      .prepare('INSERT INTO dream_runs (id, team_id, agent_id, project_key, date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, teamId, agentId, project_key.trim(), date.trim(), 'claimed', Date.now())
      .run()
    return json({ claimed: true })
  } catch {
    // UNIQUE constraint hit — another daemon already claimed tonight for this project.
    return json({ claimed: false })
  }
}

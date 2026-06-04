import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'
import { PlannerEngine } from '../planner/engine.js'
import { TaskDispatcher } from '../planner/dispatcher.js'
import { DefaultSupervisorStrategy } from '../planner/supervisor.js'
import type { PlannerRow, PhaseRow } from '../planner/types.js'

// ── Shared helpers ────────────────────────────────────────────────────────────

async function requireMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

/** Singleton engine instance per Worker invocation (stateless). */
function makeEngine(): PlannerEngine {
  return new PlannerEngine(new TaskDispatcher(), new DefaultSupervisorStrategy())
}

// ── Serialise rows to API shape ───────────────────────────────────────────────

function serialisePlanner(row: PlannerRow) {
  return {
    ...row,
    planner_id: row.id,
    auto_close: !!row.auto_close,
    paused:     !!row.paused,
  }
}

function serialisePhase(row: PhaseRow) {
  return {
    ...row,
    phase_id:  row.id,
    auto_close: !!row.auto_close,
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

interface CreatePhaseInput {
  name: string
  sub_agent_id?: string
  harness_agent_id?: string
  max_retries?: number
  auto_close?: boolean
}

interface CreatePlannerBody {
  name: string
  description?: string
  max_retries?: number
  auto_close?: boolean
  default_sub_agent_id?: string
  default_harness_agent_id?: string
  phases: CreatePhaseInput[]
}

function validateCreate(body: unknown): string | null {
  const b = body as Partial<CreatePlannerBody>
  if (!b.name?.trim()) return 'name_required'
  if (!Array.isArray(b.phases) || b.phases.length === 0) return 'phases_required'
  if (b.max_retries !== undefined && (b.max_retries < 1 || b.max_retries > 20)) return 'invalid_max_retries'
  for (const p of b.phases) {
    if (!p.name?.trim()) return 'phase_name_required'
  }
  return null
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url    = new URL(req.url)
  const teamId = url.pathname.split('/')[2]
  if (!teamId) return err('team_id_required', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const { results: rows } = await env.DB
    .prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM planner_phases pp WHERE pp.planner_id = p.id) AS phase_count
      FROM planners p
      WHERE p.team_id = ?
      ORDER BY p.created_at DESC
    `)
    .bind(teamId)
    .all<PlannerRow & { phase_count: number }>()

  return json({ planners: rows.map(r => ({ ...serialisePlanner(r), phase_count: r.phase_count })) })
}

export async function get(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url       = new URL(req.url)
  const teamId    = url.pathname.split('/')[2]
  const plannerId = url.pathname.split('/')[4]
  if (!teamId || !plannerId) return err('missing_fields', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const planner = await env.DB
    .prepare('SELECT * FROM planners WHERE id = ? AND team_id = ?')
    .bind(plannerId, teamId)
    .first<PlannerRow>()
  if (!planner) return err('not_found', 404)

  const { results: phases } = await env.DB
    .prepare(`
      SELECT pp.*, t.status AS task_status
      FROM planner_phases pp
      LEFT JOIN tasks t ON t.id = pp.task_id
      WHERE pp.planner_id = ?
      ORDER BY pp.phase_index ASC
    `)
    .bind(plannerId)
    .all<PhaseRow & { task_status: string | null }>()

  return json({ ...serialisePlanner(planner), phases: phases.map(r => ({ ...serialisePhase(r), task_status: r.task_status })) })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url    = new URL(req.url)
  const teamId = url.pathname.split('/')[2]
  if (!teamId) return err('team_id_required', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const body = await req.json<CreatePlannerBody>().catch(() => ({} as CreatePlannerBody))
  const validErr = validateCreate(body)
  if (validErr) return err(validErr, 400)

  const plannerId = ulid()
  const now       = Date.now()
  const autoClose = body.auto_close ? 1 : 0
  const maxRetries = body.max_retries ?? 3

  // Build batch: INSERT planner + INSERT all phases
  const statements = [
    env.DB.prepare(`
      INSERT INTO planners
        (id, team_id, sender_id, name, description, status, current_phase_index,
         max_retries, auto_close, paused, default_sub_agent_id, default_harness_agent_id,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', -1, ?, ?, 0, ?, ?, ?, ?)
    `).bind(
      plannerId, teamId, auth.userId,
      body.name.trim(), body.description?.trim() ?? null,
      maxRetries, autoClose,
      body.default_sub_agent_id ?? null,
      body.default_harness_agent_id ?? null,
      now, now,
    ),
    ...body.phases.map((p, i) => {
      const phaseAutoClose = p.auto_close !== undefined ? (p.auto_close ? 1 : 0) : autoClose
      return env.DB.prepare(`
        INSERT INTO planner_phases
          (id, planner_id, phase_index, name, sub_agent_id, harness_agent_id,
           status, max_retries, auto_close, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).bind(
        ulid(), plannerId, i,
        p.name.trim(),
        p.sub_agent_id ?? body.default_sub_agent_id ?? null,
        p.harness_agent_id ?? body.default_harness_agent_id ?? null,
        p.max_retries ?? maxRetries,
        phaseAutoClose,
        now, now,
      )
    }),
  ]

  await env.DB.batch(statements)

  // Kick off phase 0
  const engine = makeEngine()
  const events = await engine.advance(env.DB, plannerId)

  const dispatched = events.find(e => e.type === 'phase_dispatched')
  const firstTaskId = dispatched && 'taskId' in dispatched ? dispatched.taskId : null

  return json({ id: plannerId, status: 'running', first_task_id: firstTaskId }, 201)
}

export async function patch(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url       = new URL(req.url)
  const teamId    = url.pathname.split('/')[2]
  const plannerId = url.pathname.split('/')[4]
  if (!teamId || !plannerId) return err('missing_fields', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const planner = await env.DB
    .prepare('SELECT * FROM planners WHERE id = ? AND team_id = ?')
    .bind(plannerId, teamId)
    .first<PlannerRow>()
  if (!planner) return err('not_found', 404)

  const body = await req.json<{
    paused?: boolean
    planner_verdict?: 0 | 1 | null
  }>().catch(() => ({} as Record<string, unknown>))

  const sets: string[] = ['updated_at = ?']
  const binds: unknown[] = [Date.now()]

  if ('paused' in body) {
    sets.push('paused = ?')
    binds.push(body.paused ? 1 : 0)
  }
  if ('planner_verdict' in body) {
    sets.push('planner_verdict = ?')
    binds.push(body.planner_verdict ?? null)
  }

  await env.DB
    .prepare(`UPDATE planners SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds, plannerId)
    .run()

  // Resume — re-check if current phase can advance
  if ('paused' in body && !body.paused && planner.paused) {
    const engine = makeEngine()
    await engine.resume(env.DB, plannerId)
  }

  return json({ ok: true })
}

export async function del(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url       = new URL(req.url)
  const teamId    = url.pathname.split('/')[2]
  const plannerId = url.pathname.split('/')[4]
  if (!teamId || !plannerId) return err('missing_fields', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const { meta } = await env.DB
    .prepare('DELETE FROM planners WHERE id = ? AND team_id = ?')
    .bind(plannerId, teamId)
    .run()

  if (!meta.changes) return err('not_found', 404)

  return new Response(null, { status: 204 })
}

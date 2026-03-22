import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'

async function requireMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

export type ConveyorFrequency = 'daily' | 'weekly' | 'monthly'

export interface ConveyorRow {
  id: string
  team_id: string
  agent_id: string
  sender_id: string
  subject: string
  body: string
  frequency: ConveyorFrequency
  hour: number
  minute: number
  day_of_week: number | null
  day_of_month: number | null
  repeat_count: number | null
  repeat_counter: number
  end_date: number | null
  next_run_at: number
  created_at: number
}

/**
 * Calculates the next occurrence of a recurring task after baseTime.
 * baseTime is the previous scheduled time (or creation time for first run).
 * minute defaults to 0 for rows created before the minute column was added.
 */
export function calculateNextRun(
  baseTime: number,
  frequency: ConveyorFrequency,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  hour: number,
  minute: number = 0
): number {
  if (frequency === 'daily') {
    const candidate = new Date(baseTime)
    candidate.setHours(hour, minute, 0, 0)
    if (candidate.getTime() > baseTime) return candidate.getTime()
    candidate.setDate(candidate.getDate() + 1)
    candidate.setHours(hour, minute, 0, 0)
    return candidate.getTime()
  }

  if (frequency === 'weekly' && dayOfWeek !== null) {
    const candidate = new Date(baseTime)
    candidate.setHours(hour, minute, 0, 0)
    const currentDay = candidate.getDay()
    let daysUntil = (dayOfWeek - currentDay + 7) % 7
    // Same day but time has already passed → jump to next week
    if (daysUntil === 0 && candidate.getTime() <= baseTime) daysUntil = 7
    candidate.setDate(candidate.getDate() + daysUntil)
    return candidate.getTime()
  }

  if (frequency === 'monthly' && dayOfMonth !== null) {
    const candidate = new Date(baseTime)
    const lastDay = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate()
    candidate.setDate(Math.min(dayOfMonth, lastDay))
    candidate.setHours(hour, minute, 0, 0)
    if (candidate.getTime() > baseTime) return candidate.getTime()
    // Roll to next month
    candidate.setMonth(candidate.getMonth() + 1)
    const nextLastDay = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0).getDate()
    candidate.setDate(Math.min(dayOfMonth, nextLastDay))
    candidate.setHours(hour, minute, 0, 0)
    return candidate.getTime()
  }

  return baseTime + 86_400_000 // fallback: +1 day
}

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]
  if (!teamId) return err('team_id_required', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const { results: conveyors } = await env.DB
    .prepare('SELECT * FROM conveyors WHERE team_id = ? ORDER BY created_at DESC')
    .bind(teamId)
    .all<ConveyorRow>()

  return json({ conveyors })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]
  if (!teamId) return err('team_id_required', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const body = await req.json<{
    agent_id: string
    subject: string
    body: string
    frequency: ConveyorFrequency
    hour: number
    minute?: number
    day_of_week?: number
    day_of_month?: number
    repeat_count?: number
    end_date?: number
  }>().catch(() => ({} as any))

  const { agent_id, subject, body: taskBody, frequency, hour, minute, day_of_week, day_of_month, repeat_count, end_date } = body

  if (!agent_id || !subject?.trim() || !taskBody?.trim() || !frequency || hour === undefined) {
    return err('missing_fields', 400)
  }

  // Verify agent belongs to team
  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(agent_id, teamId)
    .first<{ id: string }>()
  if (!agent) return err('agent_not_found', 404)

  const id = ulid()
  const now = Date.now()
  const minuteVal = minute ?? 0

  // Calculate first run
  const nextRunAt = calculateNextRun(
    now,
    frequency,
    day_of_week ?? null,
    day_of_month ?? null,
    hour,
    minuteVal
  )

  await env.DB
    .prepare(`
      INSERT INTO conveyors (
        id, team_id, agent_id, sender_id, subject, body,
        frequency, hour, minute, day_of_week, day_of_month,
        repeat_count, end_date, next_run_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      id, teamId, agent_id, auth.userId, subject.trim(), taskBody.trim(),
      frequency, hour, minuteVal, day_of_week ?? null, day_of_month ?? null,
      repeat_count ?? null, end_date ?? null, nextRunAt, now
    )
    .run()

  return json({ id, next_run_at: nextRunAt }, 201)
}

export async function remove(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]
  const conveyorId = url.pathname.split('/')[4]

  if (!teamId || !conveyorId) return err('missing_fields', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('forbidden', 403)

  const { meta } = await env.DB
    .prepare('DELETE FROM conveyors WHERE id = ? AND team_id = ?')
    .bind(conveyorId, teamId)
    .run()

  if (!meta.changes) return err('not_found', 404)

  return new Response(null, { status: 204 })
}

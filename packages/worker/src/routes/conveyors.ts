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
  timezone: string
}

/**
 * Returns date/time components for a UTC timestamp expressed in the given IANA timezone.
 */
function getLocalParts(ts: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(ts))
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? '0'
  const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: parseInt(g('year')),
    month: parseInt(g('month')) - 1, // 0-indexed
    day: parseInt(g('day')),
    hour: parseInt(g('hour')) % 24,  // guard against "24" midnight variant
    minute: parseInt(g('minute')),
    weekday: DAYS[g('weekday')] ?? 0,
  }
}

/**
 * Converts a local date/time in the given IANA timezone to a UTC timestamp (ms).
 * Uses the Intl round-trip technique — correct across DST boundaries.
 */
function localToUtcMs(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  // Treat local parts as if they were UTC ("naive" UTC)
  const naive = Date.UTC(year, month, day, hour, minute)
  // Format that naive UTC in the target timezone to read back the offset
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric',
    hour12: false,
  }).formatToParts(new Date(naive))
  const g = (t: string) => parseInt(parts.find(p => p.type === t)?.value ?? '0')
  const shownAsUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'))
  // naive - shownAsUtc == tz_offset; real UTC = naive - offset = 2*naive - shownAsUtc
  return 2 * naive - shownAsUtc
}

/**
 * Calculates the next occurrence of a recurring task after baseTime.
 * baseTime is the previous scheduled time (or creation time for first run).
 * hour/minute are interpreted in the given IANA timezone (defaults to 'UTC').
 */
export function calculateNextRun(
  baseTime: number,
  frequency: ConveyorFrequency,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  hour: number,
  minute = 0,
  timezone = 'UTC'
): number {
  const local = getLocalParts(baseTime, timezone)

  if (frequency === 'daily') {
    const candidate = localToUtcMs(local.year, local.month, local.day, hour, minute, timezone)
    if (candidate > baseTime) return candidate
    return localToUtcMs(local.year, local.month, local.day + 1, hour, minute, timezone)
  }

  if (frequency === 'weekly' && dayOfWeek !== null) {
    const candidate = localToUtcMs(local.year, local.month, local.day, hour, minute, timezone)
    let daysUntil = (dayOfWeek - local.weekday + 7) % 7
    // Same day but time already passed → jump to next week
    if (daysUntil === 0 && candidate <= baseTime) daysUntil = 7
    return localToUtcMs(local.year, local.month, local.day + daysUntil, hour, minute, timezone)
  }

  if (frequency === 'monthly' && dayOfMonth !== null) {
    const lastDay = new Date(Date.UTC(local.year, local.month + 1, 0)).getUTCDate()
    const candidate = localToUtcMs(local.year, local.month, Math.min(dayOfMonth, lastDay), hour, minute, timezone)
    if (candidate > baseTime) return candidate
    const nextLastDay = new Date(Date.UTC(local.year, local.month + 2, 0)).getUTCDate()
    return localToUtcMs(local.year, local.month + 1, Math.min(dayOfMonth, nextLastDay), hour, minute, timezone)
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
    timezone?: string
  }>().catch(() => ({} as any))

  const { agent_id, subject, body: taskBody, frequency, hour, minute, day_of_week, day_of_month, repeat_count, end_date, timezone } = body

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
  const tz = timezone ?? 'UTC'

  // Calculate first run using the creator's local timezone
  const nextRunAt = calculateNextRun(
    now,
    frequency,
    day_of_week ?? null,
    day_of_month ?? null,
    hour,
    minuteVal,
    tz
  )

  await env.DB
    .prepare(`
      INSERT INTO conveyors (
        id, team_id, agent_id, sender_id, subject, body,
        frequency, hour, minute, day_of_week, day_of_month,
        repeat_count, end_date, next_run_at, created_at, timezone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      id, teamId, agent_id, auth.userId, subject.trim(), taskBody.trim(),
      frequency, hour, minuteVal, day_of_week ?? null, day_of_month ?? null,
      repeat_count ?? null, end_date ?? null, nextRunAt, now, tz
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

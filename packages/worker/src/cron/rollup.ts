import { ulid } from 'ulidx'
import type { Env } from '../types.js'

// ─── Memory rollups ──────────────────────────────────────────────────────────
// Daily/weekly summaries of a team's global memory entries, computed here because
// this is the only vantage point with visibility across every agent's sessions in
// a period — an in-session close-step skill only ever sees its own session
// (see the spec's critique #3). Driven by the Cron Trigger in wrangler.toml,
// which fires hourly and relies on runRollups/runRollupForTeam to no-op outside
// each period's own idempotent window (UNIQUE(team_id, period, period_key)).

export type RollupPeriod = 'daily' | 'weekly'

// Formats a UTC date as 'YYYY-MM-DD'.
export function dailyPeriodKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// Formats a UTC date as its ISO 8601 week, e.g. '2026-W28'.
export function weeklyPeriodKey(date: Date): string {
  // ISO weeks start Monday and week 1 is the week containing the year's first Thursday.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const isoDayNum = d.getUTCDay() || 7 // Sunday (0) -> 7
  d.setUTCDate(d.getUTCDate() + 4 - isoDayNum) // shift to this week's Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

// Returns the [start, end) epoch-ms window for a period containing `now`, plus
// its period_key.
export function periodBounds(period: RollupPeriod, now: Date): { start: number; end: number; periodKey: string } {
  if (period === 'daily') {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    return { start, end: start + 24 * 60 * 60 * 1000, periodKey: dailyPeriodKey(now) }
  }
  const isoDayNum = now.getUTCDay() || 7
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (isoDayNum - 1))
  return { start: monday, end: monday + 7 * 24 * 60 * 60 * 1000, periodKey: weeklyPeriodKey(now) }
}

const CATEGORY_ORDER = ['personal', 'preferences', 'structure', 'architecture', 'events'] as const

export interface MemoryRowForRollup {
  category: string
  title: string
  content: string
}

// Compiles memory rows into a markdown bullet list grouped by category. This is
// a plain concatenate-and-format pass for v1 — no LLM call. A real summarization
// pass (e.g. an LLM call over the same rows) could replace this later without
// changing the memory_rollup table shape or the callers that read it.
export function compileRollupContent(rows: MemoryRowForRollup[]): string {
  if (rows.length === 0) return '_No memory entries recorded in this period._'

  const byCategory = new Map<string, MemoryRowForRollup[]>()
  for (const row of rows) {
    const bucket = byCategory.get(row.category)
    if (bucket) bucket.push(row)
    else byCategory.set(row.category, [row])
  }

  const sections: string[] = []
  for (const category of CATEGORY_ORDER) {
    const bucket = byCategory.get(category)
    if (!bucket?.length) continue
    const lines = bucket.map(r => `- **${r.title}** — ${excerpt(r.content)}`)
    sections.push(`## ${capitalize(category)}\n${lines.join('\n')}`)
  }

  return sections.join('\n\n')
}

function excerpt(content: string, maxLen = 140): string {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Computes and stores the daily and weekly rollup for one team, unless one
// already exists for the current period_key. INSERT OR IGNORE is the actual
// idempotency guard (UNIQUE(team_id, period, period_key)); the pre-check just
// avoids re-scanning `memory` on every hourly tick once a period is done.
async function runRollupForTeam(env: Env, teamId: string, period: RollupPeriod, now: Date): Promise<void> {
  const { start, end, periodKey } = periodBounds(period, now)

  const already = await env.DB
    .prepare('SELECT 1 FROM memory_rollup WHERE team_id = ? AND period = ? AND period_key = ?')
    .bind(teamId, period, periodKey)
    .first()
  if (already) return

  const rows = await env.DB
    .prepare('SELECT category, title, content FROM memory WHERE team_id = ? AND created_at >= ? AND created_at < ? ORDER BY category ASC, created_at ASC')
    .bind(teamId, start, end)
    .all<MemoryRowForRollup>()

  const content = compileRollupContent(rows.results)

  await env.DB
    .prepare('INSERT OR IGNORE INTO memory_rollup (id, team_id, period, period_key, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(ulid(), teamId, period, periodKey, content, Date.now())
    .run()
}

// Cron entry point (see index.ts's `scheduled` export). Computes both the daily
// and weekly rollup for every team with memory_enabled=1. `now` is injectable
// for tests; production calls always use the real current time.
export async function runRollups(env: Env, now: Date = new Date()): Promise<void> {
  const teams = await env.DB
    .prepare('SELECT id FROM teams WHERE memory_enabled = 1 AND is_deactivated = 0')
    .all<{ id: string }>()

  for (const team of teams.results) {
    await runRollupForTeam(env, team.id, 'daily', now)
    await runRollupForTeam(env, team.id, 'weekly', now)
  }
}

import type { Env, AuthContext, DaemonContext } from '../types.js'
import { json, err } from '../auth.js'
import { requireMember } from './helpers.js'

// ── Daemon session report ────────────────────────────────────────────────────
// At session close the daemon summarizes the harness transcript locally and
// posts aggregate counts only. Everything is clamped so a misbehaving client
// can't bloat D1.

const MAX_NAMES = 100
const MAX_NAME_LENGTH = 120
const MAX_COUNT = 1_000_000_000

export interface SessionMetrics {
  provider: string
  model: string
  duration_ms: number
  turns: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  tool_calls: number
  tool_errors: number
  tools: Record<string, number>
  skills: Record<string, number>
}

function count(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0
  return Math.min(Math.max(n, 0), MAX_COUNT)
}

function label(value: unknown, max = MAX_NAME_LENGTH): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Keeps the largest `MAX_NAMES` entries with non-empty names and positive counts. */
export function sanitizeCounts(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([name, n]) => [label(name), count(n)] as const)
    .filter(([name, n]) => name.length > 0 && n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_NAMES)
  const out: Record<string, number> = {}
  for (const [name, n] of entries) out[name] = (out[name] ?? 0) + n
  return out
}

export function sanitizeMetrics(body: Record<string, unknown>): SessionMetrics {
  const tokens = (body.tokens && typeof body.tokens === 'object' ? body.tokens : {}) as Record<string, unknown>
  const tools = sanitizeCounts(body.tools)
  return {
    provider: label(body.provider, 40),
    model: label(body.model, 120),
    duration_ms: count(body.duration_ms),
    turns: count(body.turns),
    input_tokens: count(tokens.input),
    output_tokens: count(tokens.output),
    cache_read_tokens: count(tokens.cache_read),
    cache_write_tokens: count(tokens.cache_write),
    // Trust the reported total when present (it includes calls beyond the name cap).
    tool_calls: count(body.tool_calls) || Object.values(tools).reduce((a, b) => a + b, 0),
    tool_errors: count(body.tool_errors),
    tools,
    skills: sanitizeCounts(body.skills),
  }
}

export async function reportSessionMetrics(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
  if (!sessionId) return err('missing_fields', 400)

  const session = await env.DB
    .prepare('SELECT s.task_id, t.team_id FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ? AND s.agent_id = ?')
    .bind(sessionId, daemon.agentId)
    .first<{ task_id: string; team_id: string }>()
  if (!session) return err('not_found', 404)

  const m = sanitizeMetrics(body)
  await env.DB.prepare(`
    INSERT INTO session_metrics (session_id, task_id, agent_id, team_id, provider, model, duration_ms, turns,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, tool_calls, tool_errors, tools, skills, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      provider = excluded.provider, model = excluded.model, duration_ms = excluded.duration_ms, turns = excluded.turns,
      input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
      tool_calls = excluded.tool_calls, tool_errors = excluded.tool_errors, tools = excluded.tools, skills = excluded.skills`)
    .bind(sessionId, session.task_id, daemon.agentId, session.team_id, m.provider, m.model, m.duration_ms, m.turns,
      m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_write_tokens, m.tool_calls, m.tool_errors,
      JSON.stringify(m.tools), JSON.stringify(m.skills), Date.now())
    .run()
  return json({ ok: true })
}

// ── Team statistics ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000
const MAX_RANGE_MS = 366 * DAY_MS
const IN_PROGRESS = new Set(['pending', 'running', 'waiting_input', 'wrapping_up'])

export interface TaskRow { id: string; agent_id: string; status: string; created_at: number; completed_at: number | null; grade: number | null; started: number }
export interface MetricsRow {
  agent_id: string; provider: string; model: string; duration_ms: number; turns: number
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number
  tool_calls: number; tool_errors: number; tools: string; skills: string
}
export interface AgentRow { id: string; name: string }

interface AgentStats {
  agent_id: string; name: string
  tasks: number; started: number; done: number; failed: number; cancelled: number; in_progress: number
  success_rate: number | null
  median_completion_ms: number | null
  grades_up: number; grades_down: number
  sessions_reported: number; active_ms: number; turns: number
  input_tokens: number; output_tokens: number; tool_calls: number; tool_errors: number
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function parseCounts(text: string): Record<string, number> {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, number> : {}
  } catch { return {} }
}

function topCounts(maps: Record<string, number>[], limit: number) {
  const totals = new Map<string, number>()
  for (const map of maps) for (const [name, n] of Object.entries(map)) {
    if (typeof n === 'number' && n > 0) totals.set(name, (totals.get(name) ?? 0) + n)
  }
  return [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name, count]) => ({ name, count }))
}

/**
 * Pure aggregation behind GET /teams/:teamId/stats. `tzOffsetMinutes` is the
 * browser's `Date.getTimezoneOffset()`, so days bucket in the viewer's zone.
 */
export function aggregateStats(input: {
  from: number; to: number; tzOffsetMinutes: number
  tasks: TaskRow[]; metrics: MetricsRow[]; agents: AgentRow[]
}) {
  const { from, to, tzOffsetMinutes, tasks, metrics, agents } = input
  const shift = -tzOffsetMinutes * 60_000
  const dayKey = (ms: number) => new Date(Math.floor((ms + shift) / DAY_MS) * DAY_MS).toISOString().slice(0, 10)

  const days = new Map<string, { date: string; created: number; done: number; failed: number }>()
  for (let t = from; t <= to; t += DAY_MS) days.set(dayKey(t), { date: dayKey(t), created: 0, done: 0, failed: 0 })
  days.set(dayKey(to), days.get(dayKey(to)) ?? { date: dayKey(to), created: 0, done: 0, failed: 0 })

  const names = new Map(agents.map(a => [a.id, a.name]))
  const perAgent = new Map<string, AgentStats & { completions: number[] }>()
  const agentStats = (id: string) => {
    let s = perAgent.get(id)
    if (!s) {
      s = { agent_id: id, name: names.get(id) ?? 'Deleted agent', tasks: 0, started: 0, done: 0, failed: 0, cancelled: 0, in_progress: 0,
            success_rate: null, median_completion_ms: null, grades_up: 0, grades_down: 0, sessions_reported: 0, active_ms: 0, turns: 0,
            input_tokens: 0, output_tokens: 0, tool_calls: 0, tool_errors: 0, completions: [] }
      perAgent.set(id, s)
    }
    return s
  }

  const totals = { created: 0, started: 0, done: 0, failed: 0, cancelled: 0, in_progress: 0, scheduled: 0, grades_up: 0, grades_down: 0 }
  const completions: number[] = []
  for (const task of tasks) {
    const a = agentStats(task.agent_id)
    totals.created++; a.tasks++
    if (task.started) { totals.started++; a.started++ }
    if (task.status === 'done') { totals.done++; a.done++ }
    else if (task.status === 'failed') { totals.failed++; a.failed++ }
    else if (task.status === 'cancelled') { totals.cancelled++; a.cancelled++ }
    else if (task.status === 'scheduled') totals.scheduled++
    else if (IN_PROGRESS.has(task.status)) { totals.in_progress++; a.in_progress++ }
    if (task.grade === 1) { totals.grades_up++; a.grades_up++ }
    if (task.grade === 0) { totals.grades_down++; a.grades_down++ }
    if (task.status === 'done' && task.completed_at && task.completed_at >= task.created_at) {
      const ms = task.completed_at - task.created_at
      completions.push(ms); a.completions.push(ms)
    }
    const day = days.get(dayKey(task.created_at))
    if (day) {
      day.created++
      if (task.status === 'done') day.done++
      if (task.status === 'failed') day.failed++
    }
  }

  const usage = { sessions_reported: 0, active_ms: 0, turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
                  cache_write_tokens: 0, tool_calls: 0, tool_errors: 0 }
  const models = new Map<string, number>()
  for (const m of metrics) {
    const a = agentStats(m.agent_id)
    usage.sessions_reported++; a.sessions_reported++
    usage.active_ms += m.duration_ms; a.active_ms += m.duration_ms
    usage.turns += m.turns; a.turns += m.turns
    usage.input_tokens += m.input_tokens; a.input_tokens += m.input_tokens
    usage.output_tokens += m.output_tokens; a.output_tokens += m.output_tokens
    usage.cache_read_tokens += m.cache_read_tokens
    usage.cache_write_tokens += m.cache_write_tokens
    usage.tool_calls += m.tool_calls; a.tool_calls += m.tool_calls
    usage.tool_errors += m.tool_errors; a.tool_errors += m.tool_errors
    if (m.model) models.set(m.model, (models.get(m.model) ?? 0) + 1)
  }

  const agentList = [...perAgent.values()].map(({ completions: done, ...a }) => ({
    ...a,
    success_rate: a.done + a.failed > 0 ? a.done / (a.done + a.failed) : null,
    median_completion_ms: median(done),
  })).sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name))

  return {
    range: { from, to },
    totals: { ...totals, success_rate: totals.done + totals.failed > 0 ? totals.done / (totals.done + totals.failed) : null,
              median_completion_ms: median(completions) },
    daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    usage: { ...usage, models: [...models].sort((a, b) => b[1] - a[1]).map(([name, sessions]) => ({ name, sessions })) },
    tools: topCounts(metrics.map(m => parseCounts(m.tools)), 25),
    skills: topCounts(metrics.map(m => parseCounts(m.skills)), 25),
    agents: agentList,
  }
}

export async function teamStats(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const now = Date.now()
  const to = Math.min(Number(url.searchParams.get('to')) || now, now)
  const from = Math.max(Number(url.searchParams.get('from')) || to - 30 * DAY_MS, to - MAX_RANGE_MS)
  if (from >= to) return err('invalid_range', 400)
  const agentId = url.searchParams.get('agent_id') || null
  const tzOffsetMinutes = Math.max(-840, Math.min(840, Number(url.searchParams.get('tz')) || 0))

  const agentFilter = agentId ? ' AND t.agent_id = ?' : ''
  const taskArgs = agentId ? [teamId, from, to, agentId] : [teamId, from, to]
  const tasks = await env.DB.prepare(`
      SELECT t.id, t.agent_id, t.status, t.created_at, t.completed_at, t.grade,
             EXISTS (SELECT 1 FROM sessions s WHERE s.task_id = t.id) AS started
      FROM tasks t WHERE t.team_id = ? AND t.created_at >= ? AND t.created_at <= ?${agentFilter}`)
    .bind(...taskArgs).all<TaskRow>()

  // Tolerate a database the 0046 migration hasn't reached yet.
  let metrics: MetricsRow[] = []
  try {
    const metricFilter = agentId ? ' AND agent_id = ?' : ''
    metrics = (await env.DB.prepare(`
        SELECT agent_id, provider, model, duration_ms, turns, input_tokens, output_tokens, cache_read_tokens,
               cache_write_tokens, tool_calls, tool_errors, tools, skills
        FROM session_metrics WHERE team_id = ? AND created_at >= ? AND created_at <= ?${metricFilter}`)
      .bind(...taskArgs).all<MetricsRow>()).results
  } catch { metrics = [] }

  const agents = await env.DB.prepare('SELECT id, name FROM agents WHERE team_id = ?').bind(teamId).all<AgentRow>()
  return json(aggregateStats({ from, to, tzOffsetMinutes, tasks: tasks.results, metrics, agents: agents.results }))
}

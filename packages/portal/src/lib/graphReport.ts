import type { GraphSnapshot } from './graph'

const dayStart = (now: number) => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const count = (items: string[]) => {
  const m = new Map<string, number>()
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1)
  return [...m].map(([k, n]) => (n > 1 ? `${n} ${k}` : `1 ${k}`)).join(', ')
}

export interface DailyReport {
  headline: string
  lines: string[]
}

/** A plain-language account of what the graph did since local midnight. */
export function dailyReport(g: GraphSnapshot, now = Date.now()): DailyReport {
  const start = dayStart(now)
  const roleOf = (assignmentId: string) => g.assignments.find((a) => a.id === assignmentId)?.role ?? 'step'
  const done = g.attempts.filter((t) => t.completed_at && t.completed_at >= start)
  const results = g.results.filter((r) => r.created_at >= start)
  const accepted = results.filter((r) => r.status === 'accepted').length
  const bad = results.filter((r) => ['invalid', 'rejected', 'stale'].includes(r.status)).length
  const attention = g.assignments.filter((a) => ['blocked', 'error', 'review'].includes(a.status) && a.role !== 'repair')
  const changed = g.nodes.filter((n) => Math.max(n.created_at, n.state_changed_at ?? 0) >= start)
  const goal =
    g.goal_verification === 'true' ? 'The goal is verified.' : g.goal_verification === 'false' ? 'The goal is not met.' : 'The goal is not verified yet.'
  const lines: string[] = []
  if (done.length) lines.push(`Finished: ${count(done.map((t) => roleOf(t.assignment_id)))}.`)
  if (results.length) lines.push(`Results: ${accepted} accepted${bad ? `, ${bad} invalid, rejected or out of date` : ''}.`)
  lines.push(
    attention.length
      ? `Needs you: ${attention.length} step${attention.length === 1 ? '' : 's'} (${count(attention.map((a) => a.role))}) blocked or waiting for review.`
      : 'Nothing is waiting on you.'
  )
  if (changed.length)
    lines.push(`Nodes changed: ${changed.slice(0, 5).map((n) => n.title).join('; ')}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''}.`)
  lines.push(
    `Budget used: ${g.budgets.attempts} of ${g.config.policy.attempt_budget} attempts, cost ${g.budgets.execution_cost} of ${g.config.policy.cost_budget}.`
  )
  const headline = done.length
    ? `${done.length} step${done.length === 1 ? '' : 's'} finished today. ${goal}`
    : `No steps finished today. ${goal}`
  return { headline, lines }
}

export interface LatestMessage {
  role: string
  status: string
  at: number
  text: string
  taskId: string | null
}

/** The newest agent result in plain words, falling back to the newest event. */
export function latestMessage(g: GraphSnapshot): LatestMessage | null {
  const r = [...g.results].sort((a, b) => b.created_at - a.created_at)[0]
  if (r) {
    const attempt = g.attempts.find((t) => t.id === r.attempt_id)
    const role = g.assignments.find((a) => a.id === attempt?.assignment_id)?.role ?? 'step'
    return { role, status: r.status, at: r.created_at, text: summarize(r.parsed ?? r.raw), taskId: attempt?.task_id ?? null }
  }
  const e = [...g.events].sort((a, b) => b.sequence - a.sequence)[0]
  return e ? { role: 'graph', status: 'event', at: e.created_at, text: e.kind.replace(/_/g, ' '), taskId: null } : null
}

/** First useful sentence of a JSON or YAML agent reply. */
export function summarize(raw: string, max = 280): string {
  let text = raw.trim()
  try {
    const v = JSON.parse(text) as Record<string, unknown>
    const pick = ['reason', 'description', 'title', 'outcome'].map((k) => v[k]).find((x) => typeof x === 'string')
    if (typeof pick === 'string') text = pick
  } catch {
    const m = /^(?:reason|description|title):\s*"?(.+?)"?\s*$/m.exec(text)
    if (m) text = m[1]
  }
  text = text.replace(/\s+/g, ' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

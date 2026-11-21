import { latestGraphAttempt, type GraphAssignment, type GraphSnapshot } from './graph'

export const graphViews = [
  ['home', 'Home'],
  ['candidates', 'Candidates'],
  ['inbox', 'Inbox'],
  ['goals', 'Goals & predictions'],
  ['stale', 'Stale jobs'],
  ['deactivated', 'Deactivated'],
  ['statistics', 'Statistics'],
  ['activity', 'Activity']
] as const
export type GraphView = (typeof graphViews)[number][0]
export const graphView = (value: string | null): GraphView =>
  graphViews.find(([id]) => id === value)?.[0] ?? 'home'

export function assignmentTitle(graph: GraphSnapshot, a: GraphAssignment) {
  const edge = graph.edges.find((e) => e.id === a.edge_id)
  const node = graph.nodes.find((n) => n.id === a.node_id)
  if (edge?.title || node?.title) return edge?.title || node!.title
  try {
    const input = JSON.parse(a.input)
    return String(input.plan?.title ?? input.title ?? input.operation?.replaceAll('_', ' ') ?? a.role)
  } catch {
    return a.role
  }
}

export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}
export const score = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'Not evaluated'

/** Match the API's three-valued rule: conflicting fresh evidence is unknown. */
export function predicateState(graph: GraphSnapshot, predicate: string, now: number) {
  const values = new Set(
    graph.evidence
      .filter(
        (e) => e.predicate === predicate && e.scope === graph.config.rule.scope && (e.expires_at ?? 0) > now
      )
      .map((e) => e.value)
  )
  return values.size === 1 && values.has('true')
    ? 'Verified'
    : values.size === 1 && values.has('false')
      ? 'Not met'
      : 'Unverified'
}

/** Age is a diagnostic, not proof a queued or blocked job has failed. */
export function staleJobs(graph: GraphSnapshot, now: number, waitingAge: number) {
  return graph.assignments
    .flatMap((a) => {
      const attempt = latestGraphAttempt(graph, a.id)
      const result = attempt && graph.results.find((r) => r.attempt_id === attempt.id)
      const live = attempt && ['pending', 'running'].includes(attempt.status)
      const age = now - (attempt?.created_at ?? a.created_at)
      const diagnosis =
        live && attempt.deadline <= now
          ? 'Past deadline'
          : a.status === 'expired'
            ? 'Expired candidate'
            : !['accepted', 'cancelled', 'continuation'].includes(a.status) && attempt?.status === 'timeout'
              ? 'Timed out'
              : a.status === 'pending' && age >= waitingAge
                ? 'Long waiting'
                : ['blocked', 'error', 'reconciling', 'restoring'].includes(a.status) && age >= waitingAge
                  ? 'Unresolved'
                  : null
      return diagnosis ? [{ assignment: a, attempt, result, age, diagnosis }] : []
    })
    .sort((a, b) => b.age - a.age)
}

export function executionStats(graph: GraphSnapshot, since: number, now: number) {
  const finished = graph.attempts.filter((a) => a.completed_at !== null && a.completed_at >= since)
  const durations = finished.map((a) => Math.max(0, a.completed_at! - a.created_at)).sort((a, b) => a - b)
  const results = graph.results.filter((r) => r.created_at >= since)
  const accepted = results.filter((r) => r.status === 'accepted').length
  const roles = new Map<string, { role: string; finished: number; timeouts: number; duration: number }>()
  for (const a of finished) {
    const role = graph.assignments.find((x) => x.id === a.assignment_id)?.role ?? 'unknown'
    const row = roles.get(role) ?? { role, finished: 0, timeouts: 0, duration: 0 }
    row.finished++
    row.timeouts += Number(a.status === 'timeout')
    row.duration += Math.max(0, a.completed_at! - a.created_at)
    roles.set(role, row)
  }
  const start = since || Math.min(graph.created_at, now)
  const width = Math.max(1, (now - start) / 24)
  const buckets = Array.from({ length: 24 }, (_, index) => ({
    at: start + index * width,
    completed: 0,
    timeout: 0
  }))
  for (const a of finished) {
    const index = Math.min(23, Math.max(0, Math.floor((a.completed_at! - start) / width)))
    buckets[index][a.status === 'timeout' ? 'timeout' : 'completed']++
  }
  return {
    finished,
    accepted,
    results: results.length,
    roles: [...roles.values()],
    buckets,
    median: durations.length
      ? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2
      : null,
    p95: durations.length ? durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] : null,
    timeouts: finished.filter((a) => a.status === 'timeout').length
  }
}

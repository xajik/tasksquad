import { RECOVERY_ROLES, CONTROL_ROLES, isPlanning } from './roles.js'
import { configuration, rows, sql, type Assignment, type Graph } from './store.js'

const BLOCKED_STREAK = 3
const BLOCKED_COOLDOWN_MS = 30 * 60_000
const recovery: readonly string[] = RECOVERY_ROLES
const control: readonly string[] = CONTROL_ROLES
export interface Eligibility {
  code: string
  message: string
  agent?: string
  cost?: number
  recovery?: number
}

/** Shared by dispatch and the read-only snapshot: diagnostics cannot drift from gates. */
export async function dispatchContext(db: D1Database, g: Graph, enabled = true) {
  const c = await configuration(db, g)
  const budgets = (await sql(db, 'SELECT * FROM graph_budgets WHERE graph_id=?', g.id).first<{
    attempts: number
    execution_cost: number
    recovery_reserved: number
    allocations: number
  }>())!
  const used = await rows<{ agent_id: string; kind: string; graph_id: string }>(
    db,
    // A closed graph's finished attempt (kept for its own reconcile) must not hold an agent that
    // other graphs need; only live attempts and the graph's own reservations count.
    `SELECT r.* FROM graph_reservations r
     JOIN graphs rg ON rg.id=r.graph_id
     LEFT JOIN graph_attempts t ON t.id=r.attempt_id
     WHERE r.graph_id=? OR rg.status!='stopped' OR t.status IN ('pending','running')`,
    g.id
  )
  const planning = await sql(
    db,
    `SELECT COUNT(*) AS n FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id
    WHERE a.graph_id=? AND a.role IN ('decompose','plan','merge')`,
    g.id
  ).first<{ n: number }>()
  return {
    db,
    g,
    c,
    budgets,
    used,
    enabled,
    now: Date.now(),
    planningCount: planning?.n ?? 0,
    executions: used.filter((r) => r.kind === 'execution' && r.graph_id === g.id).length
  }
}

export async function eligibility(
  a: Assignment,
  ctx: Awaited<ReturnType<typeof dispatchContext>>
): Promise<Eligibility> {
  const { db, g, c, budgets, used, now } = ctx
  const wait = (code: string, message: string): Eligibility => ({ code, message })
  if (a.available_at > now)
    return wait('retry_delay', `Retry available at ${new Date(a.available_at).toISOString()}.`)
  if (budgets.attempts >= c.policy.attempt_budget && !recovery.includes(a.role))
    return wait('attempt_budget', `Attempt limit reached (${budgets.attempts} / ${c.policy.attempt_budget}).`)
  if (g.status !== 'running' && !control.includes(a.role))
    return wait(
      'paused',
      g.status === 'stopped' ? 'Graph is closed.' : 'Graph is paused. Resume it to dispatch this work.'
    )
  if (!ctx.enabled && !control.includes(a.role)) return wait('disabled', 'Graph dispatch is disabled.')
  let effective = a
  if (a.role === 'repair' && a.parent_id) {
    const parent = await sql(
      db,
      'SELECT * FROM graph_assignments WHERE id=?',
      a.parent_id
    ).first<Assignment>()
    if (!parent) return wait('missing_parent', 'Recovery parent is missing.')
    effective = parent
  }
  if (['grade', 'project', 'continue'].includes(effective.role)) {
    const input = JSON.parse(effective.input)
    const work = String(input.serial_work_id ?? input.execution_result_id ?? effective.id)
    const head = await sql(
      db,
      "SELECT work_id FROM graph_serial_queue WHERE graph_id=? AND status='pending' ORDER BY sequence LIMIT 1",
      g.id
    ).first<{ work_id: string }>()
    if (head?.work_id !== work)
      return wait(
        'queue_predecessor',
        head
          ? `Waiting for earlier review ${head.work_id}.`
          : 'Review queue entry is missing; recovery is required.'
      )
    const running = await sql(
      db,
      `SELECT 1 FROM graph_attempts t JOIN graph_assignments active ON active.id=t.assignment_id
      LEFT JOIN graph_assignments parent ON parent.id=active.parent_id WHERE active.graph_id=? AND t.status IN ('pending','running')
      AND (active.role IN ('grade','project','continue') OR (active.role='repair' AND parent.role IN ('grade','project','continue'))) LIMIT 1`,
      g.id
    ).first()
    if (running) return wait('review_running', 'Another serial review is running.')
  }
  if (a.attempt_count >= a.max_attempts)
    return wait('retry_limit', 'This step has exhausted its retry limit.')
  if (a.role === 'execute' && ctx.executions >= c.policy.capacity)
    return wait('capacity', 'Execution capacity is occupied.')
  if (a.role === 'execute') {
    // Circuit breaker: a shared blocker (unreadable instructions, missing access) blocks every execution the same
    // way. After repeated consecutive blocked outcomes probe only occasionally instead of burning attempts.
    const recent = await rows<{ outcome: string | null; at: number }>(
      db,
      `SELECT json_extract(r.parsed,'$.outcome') AS outcome, r.accepted_at AS at FROM graph_results r
       JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments x ON x.id=t.assignment_id
       WHERE x.graph_id=? AND x.role='execute' AND r.status='accepted' ORDER BY r.accepted_at DESC LIMIT ?`,
      g.id,
      BLOCKED_STREAK
    )
    if (
      recent.length === BLOCKED_STREAK &&
      recent.every((r) => r.outcome === 'blocked') &&
      now - Number(recent[0].at) < BLOCKED_COOLDOWN_MS
    )
      return wait(
        'blocked_streak',
        `The last ${BLOCKED_STREAK} executions were blocked, likely by a shared problem (access or missing files). Pausing new executions until ${new Date(Number(recent[0].at) + BLOCKED_COOLDOWN_MS).toISOString()}; resolve the blocker and one attempt will probe again.`
      )
  }
  if (['execute', 'undo'].includes(a.role)) {
    const previousId = a.attempt_count > 0 ? a.id : a.parent_id
    if (previousId) {
      const previous = await sql(
        db,
        `SELECT t.session_id,t.termination_confirmed_at FROM graph_attempts t
        JOIN graph_assignments a ON a.id=t.assignment_id WHERE t.assignment_id=? AND a.role IN ('execute','undo') ORDER BY t.epoch DESC LIMIT 1`,
        previousId
      ).first<{ session_id: string | null; termination_confirmed_at: number | null }>()
      if (previous?.session_id && !previous.termination_confirmed_at)
        return wait('termination', 'Waiting for confirmation that the previous process terminated.')
    }
  }
  let cost = 0,
    reservedRecovery = 0
  if (a.role === 'execute') {
    const plan = JSON.parse(a.input).plan
    cost = Number(plan.cost)
    reservedRecovery = Number(plan.recovery_cost)
    if (budgets.execution_cost + cost > c.policy.cost_budget)
      return wait(
        'cost_budget',
        `Declared cost ${cost} exceeds remaining execution limit ${Math.max(0, c.policy.cost_budget - budgets.execution_cost)}.`
      )
    if (budgets.recovery_reserved + reservedRecovery > c.policy.recovery_budget)
      return wait(
        'recovery_budget',
        `Recovery cost ${reservedRecovery} exceeds remaining recovery limit ${Math.max(0, c.policy.recovery_budget - budgets.recovery_reserved)}.`
      )
  }
  if (isPlanning(a.role) && ctx.planningCount >= c.policy.planning_budget)
    return wait(
      'planning_budget',
      `Planning attempt limit reached (${ctx.planningCount} / ${c.policy.planning_budget}).`
    )
  const primary =
    effective.role === 'decompose'
      ? [c.policy.decomposer]
      : ['grade', 'project', 'continue', 'reconcile'].includes(effective.role)
        ? [c.policy.grader]
        : c.policy.agents
  let missingCapability = false
  const why: string[] = []
  for (const candidate of new Set([...primary, ...(c.policy.fallback ? [c.policy.fallback] : [])])) {
    const taken = used.find((r) => r.agent_id === candidate)
    if (taken) {
      why.push(`${candidate}: reserved by a ${taken.kind} (graph ${taken.graph_id})`)
      continue
    }
    if (a.role === 'execute' && candidate === c.policy.grader) {
      why.push(`${candidate}: is the grader, executor must be independent`)
      continue
    }
    const ready = await sql(
      db,
      `SELECT a.id FROM agents a LEFT JOIN agent_state s ON s.agent_id=a.id
      WHERE a.id=? AND a.team_id=? AND a.paused=0 AND a.status='idle' AND s.current_task_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM tasks WHERE agent_id=a.id AND status='pending')`,
      candidate,
      g.team_id
    ).first()
    if (!ready) {
      const state = await sql(
        db,
        `SELECT a.paused,a.status,s.current_task_id,
         (SELECT COUNT(*) FROM tasks WHERE agent_id=a.id AND status='pending') AS pending
         FROM agents a LEFT JOIN agent_state s ON s.agent_id=a.id WHERE a.id=? AND a.team_id=?`,
        candidate,
        g.team_id
      ).first<{ paused: number; status: string; current_task_id: string | null; pending: number }>()
      why.push(
        !state
          ? `${candidate}: not in this team`
          : state.paused
            ? `${candidate}: paused`
            : state.status !== 'idle'
              ? `${candidate}: status ${state.status}`
              : state.current_task_id
                ? `${candidate}: still holds task ${state.current_task_id}`
                : `${candidate}: ${state.pending} pending task(s) queued`
      )
      continue
    }
    if (['execute', 'undo'].includes(a.role)) {
      const capable = await sql(
        db,
        'SELECT 1 FROM graph_agent_capabilities WHERE agent_id=? AND version>=1 AND seen_at>?',
        candidate,
        now - 300_000
      ).first()
      if (!capable) {
        missingCapability = true
        why.push(`${candidate}: no recent graph capability heartbeat`)
        continue
      }
    }
    return {
      code: 'ready',
      message: 'Ready for the next coordinator tick.',
      agent: candidate,
      cost,
      recovery: reservedRecovery
    }
  }
  const detail = why.length ? ` (${why.join('; ')})` : ''
  return missingCapability
    ? wait('capability', `Waiting for an agent heartbeat with graph execution capabilities${detail}.`)
    : wait('agent', `Waiting for an available eligible agent; the executor and grader must be independent${detail}.`)
}

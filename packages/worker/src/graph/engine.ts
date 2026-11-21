import { dispatchContext, eligibility } from './eligibility.js'
import { MaxHeap } from './heap.js'
import { candidateWeights } from './weights.js'
import type { Env } from '../types.js'
import { bumpInboxVersion } from '../inbox_version.js'
import { parseResult, hash, templates, verifyGoal, type Role, type Policy } from './contracts.js'
import {
  assignment,
  commit,
  configuration,
  graph,
  id,
  json,
  nodeStatements,
  rows,
  sql,
  type Assignment,
  type Attempt,
  type Data,
  type Graph,
  type Result
} from './store.js'

export type GraphEnv = Pick<Env, 'DB'> & {
  POLL_CACHE: Pick<KVNamespace, 'put'>
  ACTION_GRAPH_ENABLED?: string
}

const controlRank = (role: Role) =>
  role === 'undo' || role === 'reconcile' ? 0 : ['grade', 'project', 'continue'].includes(role) ? 1 : 2
const actionable = (role: Role) => role === 'execute' || role === 'undo'

/** Restarted steps retain the answers on every earlier execution of that step. */
async function restartOwnerHistory(db: D1Database, graphId: string, root: Assignment): Promise<string[]> {
  const inputs: string[] = [], seen = new Set<string>()
  let prior: Assignment | null = root
  while (prior && prior.role === root.role && !seen.has(prior.id)) {
    seen.add(prior.id)
    const text = JSON.parse(prior.input).user_input
    if (typeof text === 'string' && text) inputs.unshift(text)
    prior = prior.parent_id
      ? await sql(db, 'SELECT * FROM graph_assignments WHERE id=? AND graph_id=?', prior.parent_id, graphId).first<Assignment>()
      : null
  }
  return inputs
}

function compactOwnerHistory(inputs: string[]): string[] {
  const separator = '\n\nFollow-up:\n'
  return inputs.filter((text, index) =>
    text && !inputs.slice(index + 1).some((later) =>
      (separator + later + separator).includes(separator + text + separator)
    )
  )
}

export async function run(db: D1Database, graphId: string, command: string, body: Data = {}): Promise<void> {
  // 'stopped' is the terminal Closed state: immutable and irreversible, like a Done inbox task.
  if (await sql(db, "SELECT 1 FROM graphs WHERE id=? AND status='stopped'", graphId).first()) {
    if (command === 'stop') return
    throw new Error('Graph is closed and cannot be changed')
  }
  if (command === 'tag' || command === 'link') {
    const { annotate } = await import('./store.js')
    await annotate(db, graphId, command, body)
    return
  }
  if (command === 'resource') {
    const { resource } = await import('./store.js')
    await resource(db, graphId, body)
    return
  }
  const g = await graph(db, graphId),
    c = await configuration(db, g)
  if (command === 'reindex') {
    await commit(db, g, 'reindex_requested', null, {}, [])
    return
  }
  if (command === 'dismiss') {
    await dismissStale(db, g)
    return
  }
  if (command === 'fail') {
    await failAssignment(db, g, String(body.assignment_id))
    return
  }
  if (command === 'regrade') {
    const r = await sql(
      db,
      `SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE r.id=? AND a.graph_id=? AND r.status='accepted'`,
      body.execution_result_id,
      g.id
    ).first<Result>()
    if (!r || (await resolve(db, r)).original.role !== 'execute')
      throw new Error('Accepted execution result required')
    if (
      await sql(
        db,
        "SELECT 1 FROM graph_grading WHERE execution_result_id=? AND status!='done'",
        r.id
      ).first()
    )
      return
    await commit(db, g, 'regrade_requested', r.id, {}, [
      sql(
        db,
        "INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,'execution',?,?)",
        g.id,
        r.id,
        Date.now()
      ),
      sql(
        db,
        `INSERT INTO graph_grading(graph_id,execution_result_id,created_at,revision) SELECT ?,?,?,COALESCE(MAX(revision),0)+1 FROM graph_grading WHERE execution_result_id=?`,
        g.id,
        r.id,
        Date.now(),
        r.id
      )
    ])
    return
  }
  if (command === 'review') {
    const r = await sql(
      db,
      `SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE r.id=? AND a.graph_id=?`,
      body.result_id,
      g.id
    ).first<Result>()
    if (!r) throw new Error('Result not found')
    if (r.output_hash !== body.output_hash || c.version !== body.config_version)
      throw new Error('Review version conflict')
    if (r.status === 'accepted' || r.status === 'rejected') return
    if (r.status !== 'review' || !['accept', 'reject'].includes(body.verdict as string))
      throw new Error('Result is not reviewable')
    const approval = sql(
      db,
      'INSERT INTO graph_approvals(result_id,output_hash,config_version,user_id,verdict,created_at) VALUES(?,?,?,?,?,?)',
      r.id,
      r.output_hash,
      c.version,
      body.user_id,
      body.verdict,
      Date.now()
    )
    if (body.verdict === 'reject')
      await commit(db, g, 'rejected', r.id, {}, [
        approval,
        sql(db, "UPDATE graph_results SET status='rejected' WHERE id=?", r.id),
        sql(
          db,
          "UPDATE graph_assignments SET status='blocked' WHERE id=(SELECT assignment_id FROM graph_attempts WHERE id=?)",
          r.attempt_id
        )
      ])
    else await accept(db, g, r, [approval])
    return
  }
  if (command === 'configure') {
    if (g.status === 'running') throw new Error('Pause before changing configuration')
    const active = await sql(
      db,
      "SELECT id FROM graph_assignments WHERE graph_id=? AND status IN ('running','pending','review','blocked','reconciling') LIMIT 1",
      g.id
    ).first()
    const { policy: normalize } = await import('./contracts.js')
    const p = normalize(body.policy as Partial<Policy>)
    // Budgets can be raised mid-run (a spent planning budget otherwise strands every pending
    // assignment); anything structural still needs the graph drained first.
    const budgetKeys = new Set(['attempt_budget', 'planning_budget', 'cost_budget', 'recovery_budget'])
    const structural = (Object.keys(p) as (keyof Policy)[]).some(
      (k) => !budgetKeys.has(k) && JSON.stringify(p[k]) !== JSON.stringify(c.policy[k])
    )
    if (active && structural) throw new Error('Resolve existing assignments before changing configuration')
    for (const a of [...p.agents, p.grader, p.decomposer, ...(p.fallback ? [p.fallback] : [])])
      if (!(await sql(db, 'SELECT id FROM agents WHERE id=? AND team_id=?', a, g.team_id).first()))
        throw new Error('Agent outside project')
    await commit(db, g, 'configured', null, {}, [
      sql(
        db,
        'INSERT INTO graph_configs(graph_id,version,policy,success_rule,created_at) VALUES(?,?,?,?,?)',
        g.id,
        c.version + 1,
        json(p),
        json(c.rule),
        Date.now()
      )
    ])
    return
  }
  if (command === 'input') {
    const a = await sql(
      db,
      "SELECT * FROM graph_assignments WHERE id=? AND graph_id=? AND status IN ('blocked','error')",
      body.assignment_id,
      g.id
    ).first<Assignment>()
    if (!a || typeof body.message !== 'string' || body.message.length > 3999)
      throw new Error('A blocked assignment and bounded input are required')
    if (a.role === 'repair') throw new Error('Provide input to the original assignment')
    let root = a
    const visited = new Set<string>()
    while (root.role === 'continue' && root.parent_id && !visited.has(root.id)) {
      visited.add(root.id)
      const parent = await sql(
        db,
        'SELECT * FROM graph_assignments WHERE id=? AND graph_id=?',
        root.parent_id,
        g.id
      ).first<Assignment>()
      if (!parent) throw new Error('Missing continuation ancestor')
      root = parent
    }
    if (root.role === 'continue') throw new Error('Continuation has no original assignment')
    const unresolved = await sql(
      db,
      `SELECT q.work_id FROM graph_serial_queue q JOIN graph_results r ON r.id=q.work_id JOIN graph_attempts t ON t.id=r.attempt_id WHERE q.graph_id=? AND q.status='pending' AND q.kind='execution' AND t.assignment_id=? AND r.status IN ('invalid','rejected') ORDER BY q.sequence LIMIT 1`,
      g.id,
      a.id
    ).first<{ work_id: string }>()
    const previousInput = JSON.parse(a.input) as Data
    // Restarted executions point to the previous execution. Recover owner answers
    // across that lineage too, including legacy restarts that replaced user_input.
    const priorInputs = await restartOwnerHistory(db, g.id, root)
    if (a.role === 'continue')
      priorInputs.push(...((previousInput.prior_user_inputs as string[]) ?? []), String(previousInput.user_input ?? ''))
    const ownerHistory = compactOwnerHistory(priorInputs)
    const serialWork =
      previousInput.serial_work_id ??
      unresolved?.work_id ??
      (['grade', 'project'].includes(a.role) ? (previousInput.execution_result_id ?? a.id) : undefined)
    const previousResults = await rows(
      db,
      `SELECT r.id,r.raw,r.parsed,r.status FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.assignment_id=?`,
      a.id
    )
    const next = await assignment(
      db,
      g,
      'continue',
      {
        assignment: a.id,
        original_role: root.role,
        previous: JSON.parse(root.input),
        prior_user_inputs: ownerHistory,
        previous_results: previousResults,
        user_input: body.message,
        ...(serialWork ? { serial_work_id: serialWork } : {})
      },
      { parent: a.id, node: a.node_id, edge: a.edge_id }
    )
    const inbox: D1PreparedStatement[] = []
    if (body.inbox_task_id !== undefined || body.inbox_message_id !== undefined) {
      const latest = await sql(
        db,
        'SELECT task_id FROM graph_attempts WHERE assignment_id=? ORDER BY epoch DESC LIMIT 1',
        a.id
      ).first<{ task_id: string }>()
      if (
        latest?.task_id !== body.inbox_task_id ||
        typeof body.inbox_message_id !== 'string' ||
        !body.user_id
      )
        throw new Error('Reply must reference the latest inbox attempt')
      inbox.push(
        sql(
          db,
          "INSERT INTO messages(id,task_id,sender_id,role,body,created_at) VALUES(?,?,?,'user',?,?)",
          body.inbox_message_id,
          body.inbox_task_id,
          body.user_id,
          body.message,
          Date.now()
        )
      )
    }
    await commit(db, g, 'input', a.id, {}, [
      ...inbox,
      ...(!serialWork
        ? [
            sql(
              db,
              "INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,'assignment',?,?)",
              g.id,
              next.id,
              Date.now()
            )
          ]
        : []),
      ...next.statements,
      sql(db, "UPDATE graph_assignments SET status='continuation' WHERE id=?", a.id)
    ])
    return
  }
  if (!['run', 'pause', 'stop'].includes(command)) throw new Error('Unknown command')
  const status = command === 'run' ? 'running' : command === 'pause' ? 'paused' : 'stopped'
  const ops: D1PreparedStatement[] = [sql(db, 'UPDATE graphs SET status=? WHERE id=?', status, g.id)]
  if (command === 'run') {
    ops.push(
      sql(
        db,
        "UPDATE graph_assignments SET status='pending',cancel_reason=NULL,available_at=? WHERE graph_id=? AND status='cancelled' AND cancel_reason='stop'",
        Date.now(),
        g.id
      )
    )
    // Edges published while paused never received an execute assignment; create them on resume.
    const orphaned = await rows<Data>(
      db,
      `SELECT e.id,e.to_id,e.title,e.description,e.body,e.from_id,e.expected_score,p.baseline,p.predicates,p.steps,p.undo_steps,p.cost,p.recovery_cost,p.resource_versions,p.effects
       FROM graph_edges e JOIN graph_plans p ON p.edge_id=e.id
       WHERE e.graph_id=? AND NOT EXISTS (SELECT 1 FROM graph_assignments a WHERE a.edge_id=e.id AND a.role='execute')`,
      g.id
    )
    for (const e of orphaned) {
      const next = await assignment(
        db,
        g,
        'execute',
        {
          plan: {
            title: e.title,
            description: e.description,
            body: e.body,
            from_id: e.from_id,
            baseline: e.baseline,
            restoration_predicates: JSON.parse(String(e.predicates)),
            steps: JSON.parse(String(e.steps)),
            undo_steps: JSON.parse(String(e.undo_steps)),
            cost: e.cost,
            recovery_cost: e.recovery_cost,
            resource_versions: JSON.parse(String(e.resource_versions)),
            effects: JSON.parse(String(e.effects)),
            expected_quality: e.expected_score ?? null
          },
          target_node: e.to_id,
          resources: await executionResources(db, g.id)
        },
        { node: String(e.to_id), edge: String(e.id) }
      )
      ops.push(...next.statements)
    }
    const previous = await sql(db, 'SELECT id FROM graph_assignments WHERE graph_id=? LIMIT 1', g.id).first()
    if (!previous) {
      const next = await assignment(db, g, 'decompose', {
        goal: g.body,
        title: g.title,
        success_rule: c.rule
      })
      ops.push(...next.statements)
    }
  }
  if (command === 'stop') {
    // Closing is permanent: nothing can be resumed, so mark cancellations as final.
    const ordinary = "('decompose','plan','merge','execute','report')"
    const unopened = `SELECT t.id FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? AND a.role IN ${ordinary} AND t.status='pending' AND t.session_id IS NULL`
    ops.push(
      sql(
        db,
        `UPDATE graph_budgets SET recovery_reserved=MAX(0,recovery_reserved-COALESCE((SELECT SUM(json_extract(a.input,'$.plan.recovery_cost')) FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? AND a.role='execute' AND t.status='pending' AND t.session_id IS NULL),0)) WHERE graph_id=?`,
        g.id,
        g.id
      ),
      sql(
        db,
        `UPDATE tasks SET status='cancelled',completed_at=? WHERE id IN (SELECT task_id FROM graph_attempts WHERE id IN (${unopened}))`,
        Date.now(),
        g.id
      ),
      sql(db, `DELETE FROM graph_reservations WHERE attempt_id IN (${unopened})`, g.id),
      sql(
        db,
        `UPDATE graph_assignments SET status='cancelled',cancel_reason='stop' WHERE graph_id=? AND (status='pending' OR id IN (SELECT assignment_id FROM graph_attempts WHERE id IN (${unopened}))) AND role IN ${ordinary}`,
        g.id,
        g.id
      ),
      sql(
        db,
        `UPDATE graph_attempts SET status='cancelled',completed_at=? WHERE id IN (${unopened})`,
        Date.now(),
        g.id
      )
    )
    // Active processes retain reservations until reconciliation. Their normal result cannot authorize more work.
    ops.push(
      sql(
        db,
        "UPDATE graph_attempts SET deadline=? WHERE status='running' AND assignment_id IN (SELECT id FROM graph_assignments WHERE graph_id=? AND role='execute')",
        Date.now(),
        g.id
      )
    )
  }
  await commit(db, g, command, null, {}, ops)
}

export async function bindAttempt(
  db: D1Database,
  taskId: string,
  agentId: string,
  sessionId: string
): Promise<boolean> {
  const attempt = await sql(db, 'SELECT * FROM graph_attempts WHERE task_id=?', taskId).first<Attempt>()
  if (!attempt) return false
  if (attempt.agent_id !== agentId || attempt.status !== 'pending' || attempt.session_id)
    throw new Error('Unexpected graph run')
  const res = await sql(
    db,
    "UPDATE graph_attempts SET session_id=?,status='running' WHERE id=? AND status='pending' AND session_id IS NULL",
    sessionId,
    attempt.id
  ).run()
  if (!res.meta.changes) throw new Error('Graph run already bound')
  return true
}

/** Must be included in session-open's DB batch, so session FK and attempt bind are atomic. */
export async function bindStatement(
  db: D1Database,
  taskId: string,
  agentId: string,
  sessionId: string
): Promise<D1PreparedStatement[]> {
  const t = await sql(db, 'SELECT * FROM graph_attempts WHERE task_id=?', taskId).first<Attempt>()
  if (!t) return []
  if (t.agent_id !== agentId || t.status !== 'pending' || t.session_id || t.deadline <= Date.now())
    throw new Error('Unexpected graph run')
  return [
    sql(db, 'INSERT INTO graph_run_claims(task_id,session_id) VALUES(?,?)', taskId, sessionId),
    sql(
      db,
      "UPDATE graph_attempts SET session_id=?,status='running' WHERE id=? AND session_id IS NULL AND status='pending'",
      sessionId,
      t.id
    )
  ]
}

export async function intake(
  env: GraphEnv,
  sessionId: string,
  agentId: string,
  raw: string
): Promise<string | null> {
  if (env.ACTION_GRAPH_ENABLED === undefined) return null
  const t = await sql(
    env.DB,
    'SELECT * FROM graph_attempts WHERE session_id=? AND agent_id=?',
    sessionId,
    agentId
  ).first<Attempt>()
  if (!t) return null
  const a = await sql(
    env.DB,
    'SELECT * FROM graph_assignments WHERE id=?',
    t.assignment_id
  ).first<Assignment>()
  if (!a) return null
  const existing = await sql(env.DB, 'SELECT id FROM graph_results WHERE attempt_id=?', t.id).first<{
    id: string
  }>()
  if (existing) return a.graph_id
  const resultId = id()
  const now = Date.now(),
    stale = t.status !== 'running' || t.epoch !== a.attempt_count || now > t.deadline
  // Size bounded before hashing/persistence. Oversize responses retain a diagnostic prefix.
  const bounded =
    new TextEncoder().encode(raw).length > 128 * 1024
      ? raw.slice(0, 60_000) + '\n[response exceeds limit]'
      : raw
  await env.DB.batch([
    sql(
      env.DB,
      'INSERT OR IGNORE INTO graph_results(id,attempt_id,raw,output_hash,status,created_at) VALUES(?,?,?,?,?,?)',
      resultId,
      t.id,
      bounded,
      await hash(bounded),
      stale ? 'stale' : 'received',
      now
    ),
    sql(
      env.DB,
      `INSERT OR IGNORE INTO messages(id,task_id,sender_id,role,body,created_at) SELECT id,?,NULL,'agent',raw,created_at FROM graph_results WHERE attempt_id=?`,
      t.task_id,
      t.id
    ),
    ...(a.role === 'execute' && !stale
      ? [
          sql(
            env.DB,
            `INSERT OR IGNORE INTO graph_grading(graph_id,execution_result_id,created_at) SELECT ?,id,? FROM graph_results WHERE attempt_id=?`,
            a.graph_id,
            now,
            t.id
          )
        ]
      : []),
    ...(a.role === 'execute' && !stale
      ? [
          sql(
            env.DB,
            `INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) SELECT ?,'execution',id,? FROM graph_results WHERE attempt_id=? AND NOT EXISTS(SELECT 1 FROM graph_serial_queue WHERE work_id=graph_results.id AND kind='execution')`,
            a.graph_id,
            now,
            t.id
          )
        ]
      : []),
    ...(!stale
      ? [
          sql(
            env.DB,
            "UPDATE graph_attempts SET status='completed',completed_at=? WHERE id=? AND status='running'",
            now,
            t.id
          ),
          sql(env.DB, "UPDATE sessions SET status='closed',closed_at=? WHERE id=?", now, sessionId),
          sql(env.DB, "UPDATE tasks SET status='done',completed_at=? WHERE id=?", now, t.task_id),
          sql(
            env.DB,
            "UPDATE agents SET status='idle' WHERE id=? AND EXISTS(SELECT 1 FROM agent_state WHERE agent_id=? AND current_session=?)",
            agentId,
            agentId,
            sessionId
          ),
          sql(
            env.DB,
            "UPDATE agent_state SET current_task_id=NULL,current_session=NULL,mode='idle',updated_at=? WHERE agent_id=? AND current_session=?",
            now,
            agentId,
            sessionId
          )
        ]
      : [
          // A stale result still means the process has ended: free the agent so retries can dispatch.
          ...releaseAgentStatements(env.DB, agentId, sessionId, now)
        ])
  ])
  return a.graph_id
}

/** The daemon's idle self-heal never runs behind a 304, so closing a graph session must free its agent itself. */
export function releaseAgentStatements(
  db: D1Database,
  agentId: string,
  sessionId: string,
  now: number
): D1PreparedStatement[] {
  return [
    sql(
      db,
      "UPDATE agents SET status='idle' WHERE id=? AND EXISTS(SELECT 1 FROM agent_state WHERE agent_id=? AND current_session=?)",
      agentId,
      agentId,
      sessionId
    ),
    sql(
      db,
      "UPDATE agent_state SET current_task_id=NULL,current_session=NULL,mode='idle',updated_at=? WHERE agent_id=? AND current_session=?",
      now,
      agentId,
      sessionId
    )
  ]
}

async function resolve(
  db: D1Database,
  r: Result
): Promise<{ a: Assignment; original: Assignment; t: Attempt }> {
  const t = (await sql(db, 'SELECT * FROM graph_attempts WHERE id=?', r.attempt_id).first<Attempt>())!
  const a = (await sql(
    db,
    'SELECT * FROM graph_assignments WHERE id=?',
    t.assignment_id
  ).first<Assignment>())!
  const original =
    a.role === 'repair'
      ? (await sql(db, 'SELECT * FROM graph_assignments WHERE id=?', a.parent_id).first<Assignment>())!
      : a
  return { a, original, t }
}

/** Mark a result invalid and ask the agent to repair it (unless this already is a repair). */
async function invalidateResult(
  db: D1Database,
  g: Graph,
  r: Result,
  a: Assignment,
  t: { id: string },
  e: unknown
): Promise<void> {
  const ops = [
    sql(db, "UPDATE graph_results SET status='invalid',validation_error=? WHERE id=?", String(e), r.id),
    sql(db, 'DELETE FROM graph_reservations WHERE attempt_id=?', t.id),
    sql(db, "UPDATE graph_assignments SET status='error' WHERE id=?", a.id)
  ]
  if (a.role !== 'repair') {
    const fix = await assignment(
      db,
      g,
      'repair',
      { raw: r.raw, original_role: a.role, original_assignment: a.id, validation_error: String(e) },
      { parent: a.id, node: a.node_id, edge: a.edge_id, originalRole: a.role as keyof typeof templates }
    )
    ops.push(...fix.statements)
  }
  await commit(db, g, 'parse_error', r.id, { error: String(e) }, ops)
}

/** A continuation waiting for review that can never be accepted (it predates parse-time validation) would hold
 * every later review behind it forever; send it back to the agent for repair. */
export async function revalidateReviews(db: D1Database, g: Graph): Promise<void> {
  const waiting = await rows<Result>(
    db,
    `SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? AND a.role='continue' AND r.status='review' AND r.parsed IS NOT NULL`,
    g.id
  )
  for (const r of waiting) {
    const { a, original, t } = await resolve(db, r)
    try {
      await assertContinuationVerified(db, original, JSON.parse(r.parsed as string) as Data)
    } catch (e) {
      await invalidateResult(db, g, r, a, t, e)
    }
  }
}

export async function processResults(db: D1Database, g: Graph): Promise<void> {
  const pending = await rows<Result>(
    db,
    `SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? AND r.status='received' ORDER BY r.created_at,r.id`,
    g.id
  )
  for (const r of pending) {
    const { a, original, t } = await resolve(db, r),
      c = await configuration(db, g)
    if (a.config_version !== c.version) {
      // A stale result is discarded, but its agent must be released and the work must not stay 'running'.
      // Blocked (not pending) so a possibly side-effecting action is never silently repeated.
      await commit(db, g, 'stale', r.id, {}, [
        sql(db, "UPDATE graph_results SET status='stale' WHERE id=?", r.id),
        sql(db, 'DELETE FROM graph_reservations WHERE attempt_id=?', t.id),
        sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=? AND status='running'", a.id)
      ])
      continue
    }
    try {
      const parsed = parseResult(original.role as keyof typeof templates, r.raw)
      assertEvidenceResources(original, parsed as Data)
      await assertReconcileRestoration(db, original, parsed as Data)
      await assertContinuationVerified(db, original, parsed as Data)
      assertGoalImpacts(original, parsed as Data)
      r.parsed = json(parsed)
    } catch (e) {
      await invalidateResult(db, g, r, a, t, e)
      continue
    }
    await commit(db, g, 'validated', r.id, {}, [
      sql(db, "UPDATE graph_results SET parsed=?,status='review' WHERE id=?", r.parsed, r.id),
      sql(db, "UPDATE graph_assignments SET status='review' WHERE id=?", a.id),
      sql(db, 'DELETE FROM graph_reservations WHERE attempt_id=?', t.id)
    ])
    r.status = 'review'
    if (!c.policy.review) {
      try {
        await accept(db, g, r)
      } catch (e) {
        await commit(db, g, 'acceptance_blocked', r.id, { error: String(e) }, [
          sql(db, 'UPDATE graph_results SET validation_error=? WHERE id=?', String(e), r.id)
        ])
      }
    }
  }
}

/** A 'restored' reconcile must verify every restoration predicate by exact text; checked at parse so repair can fix it. */
async function assertReconcileRestoration(db: D1Database, original: Assignment, d: Data): Promise<void> {
  if (original.role !== 'reconcile' || d.decision !== 'terminated_restored') return
  const prior = await sql(
    db,
    'SELECT * FROM graph_assignments WHERE id=?',
    original.parent_id
  ).first<Assignment>()
  const predicates = (((JSON.parse(prior?.input ?? '{}') as Data).plan as Data | undefined)
    ?.restoration_predicates ?? []) as string[]
  const evidence = (d.evidence as Data[]) ?? []
  const missing = predicates.filter(
    (p) => !evidence.some((e) => e.predicate === p && e.value === 'true' && Number(e.expires_at) > Date.now())
  )
  if (!predicates.length || missing.length)
    throw new Error(
      `Restoration predicates are not verified; report evidence with these exact predicate strings: ${JSON.stringify(predicates)}`
    )
}

/** Evidence must cite a resource version supplied with the plan; checked when parsing so a repair can fix it. */
function assertEvidenceResources(original: Assignment, d: Data): void {
  if (!['execute', 'undo', 'reconcile'].includes(original.role)) return
  const plan = (JSON.parse(original.input) as Data).plan as Data | undefined
  const permitted = (plan?.resource_versions ?? []) as string[]
  if (((d.evidence as Data[]) ?? []).some((e) => !permitted.includes(String(e.resource_id))))
    throw new Error(
      `Evidence references an unsupplied resource version; use only these resource IDs: ${JSON.stringify(permitted)}`
    )
}

/** A resume/restart of a side-effecting step must attest termination, baseline and checkpoint. Checked at parse
 * time so the agent is asked to repair its answer, instead of the owner hitting a dead end when accepting. */
async function assertContinuationVerified(db: D1Database, original: Assignment, d: Data): Promise<void> {
  if (original.role !== 'continue' || d.decision === 'blocked') return
  let parent = await sql(db, 'SELECT * FROM graph_assignments WHERE id=?', original.parent_id).first<Assignment>()
  const seen = new Set<string>()
  while (parent?.role === 'continue' && parent.parent_id && !seen.has(parent.id)) {
    seen.add(parent.id)
    parent = await sql(db, 'SELECT * FROM graph_assignments WHERE id=?', parent.parent_id).first<Assignment>()
  }
  if (!parent || !actionable(parent.role as Role)) return
  if (
    d.termination_verified !== true ||
    d.baseline_unchanged !== true ||
    (d.decision === 'resume' && d.checkpoint_verified !== true)
  )
    throw new Error(
      'Continuation needs verified termination, baseline and checkpoint: set termination_verified and baseline_unchanged to true (and checkpoint_verified to true for resume) only if verified; otherwise answer decision "blocked" with the reason'
    )
}

/** The root goal and every active decomposed milestone, each with the exact success predicates it owns. A milestone
 * owns the rule predicates its text names; the root goal owns them all. Grading scores impact per goal by predicate. */
export interface GoalScope {
  id: string
  kind: string
  title: string
  body: string
  predicates: string[]
}
export async function goalHierarchy(db: D1Database, g: Graph, rulePredicates: string[]): Promise<GoalScope[]> {
  const nodes = await rows<{ id: string; kind: string; title: string; body: string }>(
    db,
    `SELECT n.id,n.kind,n.title,n.body FROM graph_nodes n
     JOIN graph_node_states s ON s.id=(SELECT MAX(id) FROM graph_node_states WHERE node_id=n.id)
     WHERE n.graph_id=? AND n.kind IN ('goal','milestone') AND s.state='active'
     ORDER BY n.kind='goal' DESC, n.created_at`,
    g.id
  )
  return nodes.map((n) => ({
    ...n,
    predicates: n.kind === 'goal' ? rulePredicates : rulePredicates.filter((p) => n.body.includes(p))
  }))
}

/** Per-goal impact must name supplied goals, that goal's own predicates and supplied evidence; checked at parse so a
 * repair can fix it. Only enforced when the grading context carried the goal hierarchy. */
export function assertGoalImpacts(original: Assignment, d: Data): void {
  if (original.role !== 'project') return
  const input = JSON.parse(original.input) as Data
  const goals = input.goals as GoalScope[] | undefined
  if (!goals?.length) return
  const impacts = (d.goal_impacts ?? []) as Data[]
  const evidence = ((input.evidence as Data[]) ?? []).map((e) => e.id)
  for (const i of impacts) {
    const goal = goals.find((x) => x.id === i.goal_id)
    if (!goal) throw new Error(`goal_impacts references an unsupplied goal; use only these goal IDs: ${JSON.stringify(goals.map((x) => x.id))}`)
    const predicates = (i.predicates ?? []) as string[]
    const bad = predicates.filter((p) => !goal.predicates.includes(p))
    if (bad.length) throw new Error(`goal_impacts predicates must be exact predicates of goal ${goal.id}: ${JSON.stringify(goal.predicates)}`)
    if (Number(i.actual) > 0 && (!predicates.length || !((i.evidence_ids as string[]) ?? []).length))
      throw new Error('goal_impacts actual above 0 needs the predicates advanced and supporting evidence IDs')
    if (((i.evidence_ids as string[]) ?? []).some((e) => !evidence.includes(e)))
      throw new Error('goal_impacts references unsupplied evidence')
  }
  if (new Set(impacts.map((i) => i.goal_id)).size !== impacts.length) throw new Error('goal_impacts repeats a goal')
  if (impacts.length && !impacts.some((i) => i.goal_id === d.primary_goal_id))
    throw new Error('primary_goal_id must name a goal listed in goal_impacts')
}

async function evidenceStatements(
  db: D1Database,
  g: Graph,
  r: Result,
  node: string,
  items: Data[]
): Promise<D1PreparedStatement[]> {
  const c = await configuration(db, g),
    now = Date.now(),
    ops: D1PreparedStatement[] = []
  for (const e of items) {
    if (
      typeof e.id !== 'string' ||
      !e.resource_id ||
      !(await sql(
        db,
        'SELECT id FROM graph_resources WHERE id=? AND graph_id=?',
        e.resource_id,
        g.id
      ).first())
    )
      throw new Error('Evidence requires a supplied graph resource')
    if (
      Number(e.observed_at) > now + 60_000 ||
      Number(e.expires_at) <= Number(e.observed_at) ||
      Number(e.expires_at) > Number(e.observed_at) + c.policy.freshness_ms
    )
      throw new Error('Evidence freshness invalid')
    // Agents pick evidence IDs, but the primary key is global: a later step reusing "ev1" must not
    // block acceptance. Downstream readers take IDs from the stored rows, so mint a fresh one.
    let evidenceId = e.id as string
    if (await sql(db, 'SELECT id FROM graph_evidence WHERE id=?', evidenceId).first()) evidenceId = id()
    ops.push(
      sql(
        db,
        'INSERT INTO graph_evidence(id,graph_id,node_id,source_result_id,predicate,value,scope,observed_at,expires_at,resource_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        evidenceId,
        g.id,
        node,
        r.id,
        e.predicate,
        e.value,
        e.scope,
        e.observed_at,
        e.expires_at,
        e.resource_id,
        now
      )
    )
  }
  return ops
}

export async function accept(
  db: D1Database,
  g: Graph,
  r: Result,
  extra: D1PreparedStatement[] = []
): Promise<void> {
  const { a, original } = await resolve(db, r),
    c = await configuration(db, g)
  if (r.status === 'accepted') return
  if (r.status !== 'review' || original.config_version !== c.version || !r.parsed)
    throw new Error('Result no longer eligible')
  const d = JSON.parse(r.parsed) as Data,
    input = JSON.parse(original.input) as Data
  if (['execute', 'undo', 'reconcile'].includes(original.role)) {
    assertEvidenceResources(original, d)
  }
  const ops: D1PreparedStatement[] = [
    ...extra,
    sql(db, "UPDATE graph_results SET status='accepted',accepted_at=? WHERE id=?", Date.now(), r.id),
    sql(db, "UPDATE graph_assignments SET status='accepted' WHERE id IN (?,?)", a.id, original.id),
    ...(a.role === 'repair'
      ? [
          sql(
            db,
            "UPDATE graph_assignments SET status='cancelled' WHERE parent_id=? AND role='continue' AND status='pending'",
            original.id
          )
        ]
      : [])
  ]
  const enqueue = async (
    role: Role,
    data: unknown,
    links: { node?: string | null; edge?: string | null; parent?: string | null; priority?: number } = {}
  ) => {
    const next = await assignment(db, g, role, data, { parent: original.id, ...links })
    ops.push(...next.statements)
    return next.id
  }
  switch (original.role) {
    case 'decompose': {
      const parent = await sql(
        db,
        "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='goal' LIMIT 1",
        g.id
      ).first<{ id: string }>()
      const hierarchy = await rows(
        db,
        "SELECT id,title,description,body,parent_id FROM graph_nodes WHERE graph_id=? AND kind IN ('goal','milestone')",
        g.id
      )
      for (const sub of d.subgoals as Data[])
        if (Number(sub.necessity_confidence) >= c.policy.threshold) {
          const proposal = id(),
            candidate = { ...sub, kind: 'milestone', parent_id: parent?.id ?? null }
          ops.push(
            sql(
              db,
              'INSERT INTO graph_proposals(id,graph_id,source_result_id,content,created_at) VALUES(?,?,?,?,?)',
              proposal,
              g.id,
              r.id,
              json(candidate),
              Date.now()
            )
          )
          await enqueue('merge', {
            direction: 'backward',
            proposal_id: proposal,
            candidate,
            existing_hierarchy: hierarchy
          })
        }
      for (const node of (d.retire_ids ?? []) as string[]) {
        if (
          !(await sql(
            db,
            "SELECT id FROM graph_nodes WHERE id=? AND graph_id=? AND kind='milestone'",
            node,
            g.id
          ).first())
        )
          throw new Error('Retirement outside milestone hierarchy')
        const proposal = id(),
          candidate = { kind: 'retire', node_id: node }
        ops.push(
          sql(
            db,
            'INSERT INTO graph_proposals(id,graph_id,source_result_id,content,created_at) VALUES(?,?,?,?,?)',
            proposal,
            g.id,
            r.id,
            json(candidate),
            Date.now()
          )
        )
        await enqueue('merge', {
          direction: 'backward',
          proposal_id: proposal,
          candidate,
          existing_hierarchy: hierarchy
        })
      }
      break
    }
    case 'plan':
      for (const action of d.actions as Data[]) {
        if (
          !(await sql(
            db,
            "SELECT n.id FROM graph_nodes n WHERE n.id=? AND n.graph_id=? AND (n.kind='observed' OR EXISTS(SELECT 1 FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE r.id=n.source_result_id AND r.status='accepted' AND a.role IN ('execute','undo'))) AND (SELECT state FROM graph_node_states WHERE node_id=n.id ORDER BY id DESC LIMIT 1)='active'",
            action.from_id,
            g.id
          ).first())
        )
          throw new Error('Action source outside permitted graph')
        if (
          !(action.steps as unknown[]).length ||
          !(action.undo_steps as unknown[]).length ||
          !(action.restoration_predicates as unknown[]).length ||
          !action.baseline
        )
          throw new Error('Action needs a complete restoration contract')
        for (const resource of action.resource_versions as string[])
          if (
            !(await sql(
              db,
              "SELECT id FROM graph_resources WHERE id=? AND graph_id=? AND visibility='execution'",
              resource,
              g.id
            ).first())
          )
            throw new Error('Plan references unavailable resources')
        const proposalId = id()
        ops.push(
          sql(
            db,
            'INSERT INTO graph_proposals(id,graph_id,source_result_id,content,created_at) VALUES(?,?,?,?,?)',
            proposalId,
            g.id,
            r.id,
            json(action),
            Date.now()
          )
        )
        await enqueue(
          'merge',
          { proposal_id: proposalId, action, existing_states: await executionNodes(db, g.id) },
          { node: original.node_id }
        )
      }
      break
    case 'merge': {
      const p = await sql(
        db,
        'SELECT * FROM graph_proposals WHERE id=? AND graph_id=?',
        input.proposal_id,
        g.id
      ).first<{ id: string; content: string; status: string }>()
      if (!p || p.status !== 'pending') throw new Error('Proposal no longer pending')
      if (d.decision === 'uncertain' || d.decision === 'reject') {
        ops.push(
          sql(
            db,
            'UPDATE graph_proposals SET status=? WHERE id=?',
            d.decision === 'reject' ? 'rejected' : 'uncertain',
            p.id
          )
        )
        break
      }
      if (input.direction === 'backward') {
        const candidate = JSON.parse(p.content) as Data
        if (candidate.kind === 'retire') {
          ops.push(
            sql(
              db,
              "INSERT INTO graph_node_states(graph_id,node_id,state,reason,created_at) VALUES(?,?,'deactivated','obsolete',?)",
              g.id,
              candidate.node_id,
              Date.now()
            ),
            sql(
              db,
              "UPDATE graph_assignments SET status='cancelled' WHERE graph_id=? AND node_id=? AND status='pending'",
              g.id,
              candidate.node_id
            )
          )
        } else {
          const existing = await sql(
            db,
            "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='milestone' AND title=? AND body=? AND parent_id=?",
            g.id,
            candidate.title,
            candidate.body,
            candidate.parent_id
          ).first<{ id: string }>()
          // Like the forward case, the reviewer judges semantic equivalence; require only that it
          // names a real milestone in this graph (exact text match would never hold for a rewording).
          const equivalent =
            d.decision === 'equivalent'
              ? await sql(
                  db,
                  "SELECT id FROM graph_nodes WHERE id=? AND graph_id=? AND kind='milestone'",
                  d.equivalent_node_id,
                  g.id
                ).first<{ id: string }>()
              : null
          if (d.decision === 'equivalent' && !equivalent && existing?.id !== d.equivalent_node_id)
            throw new Error('Equivalent milestone outside graph')
          if (!existing && !equivalent) {
            const n = nodeStatements(db, g, 'milestone', candidate, r.id, String(candidate.parent_id))
            ops.push(...n.statements)
            await enqueue(
              'plan',
              {
                task: candidate,
                observed_start: g.start_state,
                observations: await executionNodes(db, g.id),
                resources: await executionResources(db, g.id)
              },
              { node: n.id }
            )
          }
        }
        ops.push(sql(db, "UPDATE graph_proposals SET status='published' WHERE id=?", p.id))
        break
      }
      const action = JSON.parse(p.content) as Data
      const duplicate = await sql(
        db,
        `SELECT e.id FROM graph_edges e JOIN graph_plans p ON p.edge_id=e.id WHERE e.graph_id=? AND e.from_id=? AND p.baseline=? AND p.resource_versions=? AND p.effects=? AND p.steps=? AND p.undo_steps=? LIMIT 1`,
        g.id,
        action.from_id,
        action.baseline,
        json(action.resource_versions),
        json(action.effects),
        json(action.steps),
        json(action.undo_steps)
      ).first<{ id: string }>()
      if (duplicate) {
        ops.push(sql(db, "UPDATE graph_proposals SET status='published' WHERE id=?", p.id))
        break
      }
      let target: string
      if (d.decision === 'equivalent') {
        const match = await sql(
          db,
          "SELECT * FROM graph_nodes WHERE id=? AND graph_id=? AND kind!='goal'",
          d.equivalent_node_id,
          g.id
        ).first<{ id: string; body: string }>()
        // Reviewer must name an existing state; action identity is still retained separately.
        if (!match) throw new Error('Equivalent state outside graph')
        const equivalent = await sql(
          db,
          `SELECT p.* FROM graph_plans p JOIN graph_edges e ON e.id=p.edge_id WHERE e.to_id=? AND e.from_id=? AND e.graph_id=? AND p.baseline=? AND p.resource_versions=? AND p.effects=? AND p.steps=? LIMIT 1`,
          match.id,
          action.from_id,
          g.id,
          action.baseline,
          json(action.resource_versions),
          json(action.effects),
          json(action.steps)
        ).first()
        if (!equivalent) throw new Error('Structured equivalence not established')
        target = match.id
      } else {
        const n = nodeStatements(db, g, 'outcome', action, r.id)
        target = n.id
        ops.push(...n.statements)
      }
      const edge = id()
      ops.push(
        sql(
          db,
          'INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at,expected_score) VALUES(?,?,?,?,?,?,?,?,?,?)',
          edge,
          g.id,
          action.from_id,
          target,
          action.title,
          action.description,
          action.body,
          r.id,
          Date.now(),
          action.expected_quality
        ),
        sql(
          db,
          'INSERT INTO graph_plans(edge_id,baseline,predicates,steps,undo_steps,cost,recovery_cost,resource_versions,effects) VALUES(?,?,?,?,?,?,?,?,?)',
          edge,
          action.baseline,
          json(action.restoration_predicates),
          json(action.steps),
          json(action.undo_steps),
          action.cost,
          action.recovery_cost,
          json(action.resource_versions),
          json(action.effects)
        ),
        sql(db, "UPDATE graph_proposals SET status='published' WHERE id=?", p.id)
      )
      if (g.status === 'running')
        await enqueue(
          'execute',
          { plan: action, target_node: target, resources: await executionResources(db, g.id) },
          { node: target, edge }
        )
      break
    }
    case 'execute': {
      const n = nodeStatements(db, g, 'outcome', d, r.id, original.node_id)
      ops.push(...n.statements, ...(await evidenceStatements(db, g, r, n.id, d.evidence as Data[])))
      if (a.role === 'repair')
        ops.push(
          sql(
            db,
            `UPDATE graph_serial_queue SET work_id=? WHERE kind='execution' AND work_id IN (SELECT r.id FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.assignment_id=?)`,
            r.id,
            original.id
          )
        )
      if (a.role === 'repair')
        ops.push(
          sql(
            db,
            `UPDATE graph_grading SET execution_result_id=? WHERE execution_result_id IN (SELECT r.id FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.assignment_id=?)`,
            r.id,
            original.id
          )
        )
      if (d.outcome === 'complete' || d.outcome === 'blocked')
        ops.push(
          sql(
            db,
            'UPDATE graph_budgets SET recovery_reserved=MAX(0,recovery_reserved-?) WHERE graph_id=?',
            Number((input.plan as Data).recovery_cost),
            g.id
          )
        )
      if (d.outcome === 'blocked')
        ops.push(sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", original.id))
      if (d.outcome === 'failed') {
        ops.push(sql(db, "UPDATE graph_assignments SET status='restoring' WHERE id=?", original.id))
        await enqueue(
          'undo',
          { plan: input.plan, failed_outcome: d, resources: await executionResources(db, g.id) },
          { node: n.id, edge: original.edge_id }
        )
      }
      break
    }
    case 'grade':
    case 'project': {
      if (original.role === 'project' && input.operation === 'decomposition_review') {
        const allowed = (input.evidence as Data[]).map((e) => e.id)
        if ((d.evidence_ids as string[]).some((e) => !allowed.includes(e)))
          throw new Error('Review references unsupplied evidence')
        const feedback = (d.decomposition_feedback as unknown[] | undefined) ?? []
        const running = await sql(
          db,
          "SELECT 1 FROM graph_assignments WHERE graph_id=? AND role='decompose' AND status IN ('running','review') LIMIT 1",
          g.id
        ).first()
        if (feedback.length && !running) {
          ops.push(
            sql(
              db,
              "UPDATE graph_assignments SET status='cancelled',cancel_reason='superseded' WHERE graph_id=? AND role='decompose' AND status='pending' AND attempt_count=0",
              g.id
            )
          )
          await enqueue('decompose', {
            goal: g.body,
            title: g.title,
            success_rule: c.rule,
            existing_milestones: input.hierarchy,
            abstract_feedback: feedback
          })
        }
        ops.push(
          sql(
            db,
            "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND kind='assignment' AND work_id=?",
            g.id,
            input.serial_work_id ?? original.id
          )
        )
        break
      }

      const ids = d.evidence_ids as string[]
      const allowed = (input.evidence as Data[]).map((e) => e.id)
      if (ids.some((e) => !allowed.includes(e))) throw new Error('Grade references unsupplied evidence')
      ops.push(
        sql(
          db,
          'INSERT INTO graph_evaluation_revisions(graph_id,execution_result_id,role,source_result_id,created_at) VALUES(?,?,?,?,?)',
          g.id,
          input.execution_result_id,
          original.role,
          r.id,
          Date.now()
        )
      )
      // The stored goal score is the root goal's actual impact; per-goal detail stays in the result itself.
      const rootImpact = ((d.goal_impacts ?? []) as Data[]).find(
        (i) => i.goal_id === ((input.goals as GoalScope[] | undefined) ?? []).find((x) => x.kind === 'goal')?.id
      )
      const rootScore = rootImpact ? rootImpact.actual : d.goal_score
      const lineage = await executedLineage(db, g.id, original.edge_id)
      for (const edge of lineage)
        for (const evidence of ids)
          ops.push(
            sql(
              db,
              'INSERT INTO graph_evaluations(graph_id,edge_id,source_result_id,evidence_id,context,local_score,goal_score,created_at) VALUES(?,?,?,?,?,?,?,?)',
              g.id,
              edge,
              r.id,
              evidence,
              `${input.execution_result_id}:${original.role}:${edge}`,
              original.role === 'grade' ? d.local_score : null,
              original.role === 'project' ? rootScore : null,
              Date.now()
            )
          )
      ops.push(
        sql(
          db,
          'UPDATE graph_grading SET stage=?,assignment_id=NULL,status=? WHERE sequence=?',
          original.role === 'grade' ? 'project' : 'done',
          original.role === 'grade' ? 'pending' : 'done',
          input.grading_sequence
        )
      )
      if (original.role === 'project')
        ops.push(
          sql(
            db,
            "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND kind='execution' AND work_id=? AND status='pending'",
            g.id,
            input.execution_result_id
          )
        )
      if (
        original.role === 'project' &&
        (input.result as Data).outcome === 'complete' &&
        g.status === 'running'
      ) {
        const evidence = await rows<{
          predicate: string
          value: 'true' | 'false' | 'unknown'
          scope: string
          expires_at: number
        }>(db, 'SELECT * FROM graph_evidence WHERE graph_id=?', g.id)
        if (verifyGoal(c.rule, evidence, Date.now()) !== 'true')
          await enqueue('plan', {
            task: {
              title: 'Next bounded experiment',
              description: '',
              body: 'Explore alternatives from observed results'
            },
            observations: await executionNodes(db, g.id),
            resources: await executionResources(db, g.id),
            feedback: { goal_alignment: d.goal_score }
          })
      }
      break
    }
    case 'undo': {
      const n = nodeStatements(db, g, 'restoration', d, r.id, original.node_id)
      ops.push(...n.statements, ...(await evidenceStatements(db, g, r, n.id, d.evidence as Data[])))
      const predicates = ((input.plan as Data).restoration_predicates ?? []) as string[]
      const observed = d.evidence as Data[]
      const verified =
        d.restored === true &&
        predicates.length > 0 &&
        predicates.every((p) =>
          observed.some((e) => e.predicate === p && e.value === 'true' && Number(e.expires_at) > Date.now())
        )
      ops.push(
        sql(
          db,
          'UPDATE graph_assignments SET status=? WHERE id=?',
          verified ? 'restored' : 'blocked',
          original.parent_id
        )
      )
      if (!verified)
        ops.push(sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", original.id))
      if (verified) {
        ops.push(
          sql(
            db,
            'UPDATE graph_budgets SET recovery_reserved=MAX(0,recovery_reserved-?) WHERE graph_id=?',
            Number((input.plan as Data).recovery_cost),
            g.id
          )
        )
        const parent = await sql(
          db,
          'SELECT * FROM graph_assignments WHERE id=?',
          original.parent_id
        ).first<Assignment>()
        if (parent && parent.attempt_count < parent.max_attempts && g.status === 'running')
          ops.push(
            sql(
              db,
              "UPDATE graph_assignments SET status='pending',available_at=? WHERE id=?",
              Date.now() + retryDelay(parent.attempt_count),
              parent.id
            )
          )
      }
      break
    }
    case 'continue': {
      if (!input.serial_work_id)
        ops.push(
          sql(
            db,
            "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND kind='assignment' AND work_id=?",
            g.id,
            original.id
          )
        )
      const found = await sql(
        db,
        'SELECT * FROM graph_assignments WHERE id=?',
        original.parent_id
      ).first<Assignment>()
      if (!found) throw new Error('Missing blocked assignment')
      // A reply to a blocked continue must resume the step that started it, never spawn another
      // continue (that looped: continue -> restart -> continue ...).
      let parent: Assignment = found
      const ancestors = new Set<string>()
      while (parent.role === 'continue' && parent.parent_id && !ancestors.has(parent.id)) {
        ancestors.add(parent.id)
        const up: Assignment | null = await sql(
          db,
          'SELECT * FROM graph_assignments WHERE id=?',
          parent.parent_id
        ).first<Assignment>()
        if (!up) break
        parent = up
      }
      if (parent.role === 'continue') throw new Error('Continuation has no original assignment')
      if (d.decision === 'blocked')
        // The newest request belongs to this continuation, not its ancestor.
        ops.push(
          sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", original.id),
          sql(
            db,
            "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND work_id=?",
            g.id,
            input.serial_work_id ?? original.id
          )
        )
      else {
        // A fresh attempt is explicit; context records checkpoint semantics for the executor.
        // Judge the newest attempt: an older confirmed attempt must not mask a live later one.
        const latest = await sql(
          db,
          'SELECT session_id,termination_confirmed_at FROM graph_attempts WHERE assignment_id=? ORDER BY epoch DESC LIMIT 1',
          parent.id
        ).first<{ session_id: string | null; termination_confirmed_at: number | null }>()
        if (actionable(parent.role) && latest && latest.session_id && !latest.termination_confirmed_at)
          throw new Error('Previous process has not confirmed termination')
        if (
          actionable(parent.role) &&
          (d.termination_verified !== true ||
            d.baseline_unchanged !== true ||
            (d.decision === 'resume' && d.checkpoint_verified !== true))
        )
          throw new Error('Continuation needs verified termination, baseline and checkpoint')
        if (parent.role === 'execute' && input.serial_work_id)
          ops.push(
            sql(
              db,
              "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND work_id=? AND status='pending'",
              g.id,
              input.serial_work_id
            ),
            sql(
              db,
              "UPDATE graph_grading SET status='done' WHERE graph_id=? AND execution_result_id=?",
              g.id,
              input.serial_work_id
            )
          )
        const previousContext = JSON.parse(parent.input)
        const context = {
          ...previousContext,
          ...(parent.role === 'merge' && previousContext.direction !== 'backward'
            ? { existing_states: await executionNodes(db, g.id) }
            : {}),
          ...(parent.role === 'plan'
            ? { observations: await executionNodes(db, g.id), resources: await executionResources(db, g.id) }
            : {}),
          continuation: d,
          user_input: compactOwnerHistory([
            ...(await restartOwnerHistory(db, g.id, parent)),
            ...((input.prior_user_inputs as string[]) ?? []),
            String(input.user_input ?? '')
          ]).join('\n\nFollow-up:\n'),
          ...(input.serial_work_id ? { serial_work_id: input.serial_work_id } : {})
        }
        const next = await assignment(db, g, parent.role, context, {
          parent: parent.id,
          node: parent.node_id,
          edge: parent.edge_id
        })
        ops.push(
          ...next.statements,
          sql(db, 'UPDATE graph_assignments SET max_attempts=1 WHERE id=?', next.id)
        )
      }
      break
    }
    case 'reconcile': {
      const prior = await sql(
        db,
        'SELECT * FROM graph_assignments WHERE id=?',
        original.parent_id
      ).first<Assignment>()
      if (!prior) throw new Error('Missing interrupted assignment')
      if (d.decision === 'unknown') {
        ops.push(sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", original.id))
        break
      }
      const interrupted = await sql(
        db,
        'SELECT id FROM graph_attempts WHERE id=? AND assignment_id=? AND termination_confirmed_at IS NOT NULL',
        input.interrupted_attempt,
        prior.id
      ).first()
      if (!interrupted) throw new Error('Wait for daemon termination acknowledgement')
      const evidence = d.evidence as Data[]
      if (d.decision === 'terminated_restored') {
        const plan = JSON.parse(prior.input).plan as Data
        const predicates = plan.restoration_predicates as string[]
        if (
          !predicates.length ||
          !predicates.every((p) =>
            evidence.some((e) => e.predicate === p && e.value === 'true' && Number(e.expires_at) > Date.now())
          )
        )
          throw new Error('Restoration predicates are not verified')
      }
      if (prior.node_id) ops.push(...(await evidenceStatements(db, g, r, prior.node_id, evidence)))
      ops.push(
        sql(
          db,
          'DELETE FROM graph_reservations WHERE attempt_id IN (SELECT id FROM graph_attempts WHERE assignment_id=?)',
          prior.id
        )
      )
      if (d.decision === 'terminated_restored' && prior.role === 'execute')
        ops.push(
          sql(
            db,
            'UPDATE graph_budgets SET recovery_reserved=MAX(0,recovery_reserved-?) WHERE graph_id=?',
            Number(JSON.parse(prior.input).plan.recovery_cost),
            g.id
          )
        )
      if (d.decision === 'terminated_needs_undo')
        await enqueue(
          'undo',
          { plan: JSON.parse(prior.input).plan, resources: await executionResources(db, g.id) },
          { parent: prior.id, node: prior.node_id, edge: prior.edge_id }
        )
      else
        ops.push(
          sql(
            db,
            'UPDATE graph_assignments SET status=?,available_at=? WHERE id=?',
            prior.attempt_count < prior.max_attempts && g.status === 'running' ? 'pending' : 'error',
            Date.now() + retryDelay(prior.attempt_count),
            prior.id
          )
        )
      break
    }
  }
  await commit(db, g, 'accepted', r.id, { role: original.role }, ops)
}

export function retryDelay(attempt: number, random = Math.random()): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 480_000) * (0.8 + random * 0.4)
}
async function executionResources(db: D1Database, graphId: string): Promise<Data[]> {
  return rows(
    db,
    "SELECT id,version,title,description,body FROM graph_resources WHERE graph_id=? AND visibility='execution'",
    graphId
  )
}
async function executionNodes(db: D1Database, graphId: string): Promise<Data[]> {
  return rows(
    db,
    `SELECT n.id,n.kind,n.title,n.description,n.body,n.source_result_id,s.state
     FROM graph_nodes n JOIN graph_node_states s ON s.id=(SELECT MAX(id) FROM graph_node_states WHERE node_id=n.id)
     WHERE n.graph_id=? AND s.state='active' AND
       (n.kind='observed' OR EXISTS(SELECT 1 FROM graph_results r
        JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id
        WHERE r.id=n.source_result_id AND r.status='accepted' AND a.role IN ('execute','undo')))`,
    graphId
  )
}

export async function advanceGrading(db: D1Database, g: Graph): Promise<void> {
  const serial = await sql(
    db,
    "SELECT * FROM graph_serial_queue WHERE graph_id=? AND status='pending' ORDER BY sequence LIMIT 1",
    g.id
  ).first<{ kind: string; work_id: string }>()
  if (!serial || serial.kind !== 'execution') return
  const head = await sql(
    db,
    "SELECT * FROM graph_grading WHERE graph_id=? AND execution_result_id=? AND status!='done' ORDER BY sequence LIMIT 1",
    g.id,
    serial.work_id
  ).first<{
    sequence: number
    stage: 'grade' | 'project'
    assignment_id: string | null
    execution_result_id: string
  }>()
  if (!head || head.assignment_id) return
  const r = (await sql(
    db,
    'SELECT * FROM graph_results WHERE id=?',
    head.execution_result_id
  ).first<Result>())!
  if (r.status !== 'accepted') return
  const { original } = await resolve(db, r)
  const evidence = await rows(db, 'SELECT * FROM graph_evidence WHERE source_result_id=?', r.id)
  const context: Data = {
    execution_result_id: r.id,
    grading_sequence: head.sequence,
    result: JSON.parse(r.parsed!),
    plan: JSON.parse(original.input),
    evidence
  }
  if (head.stage === 'project') {
    const c = await configuration(db, g)
    context.private_goal = g.body
    context.rule = c.rule
    context.goals = await goalHierarchy(db, g, c.rule.predicates)
  }
  const next = await assignment(db, g, head.stage, context, {
    edge: original.edge_id,
    parent: original.id,
    node: original.node_id
  })
  await commit(db, g, 'grading_queued', next.id, {}, [
    ...next.statements,
    sql(
      db,
      "UPDATE graph_grading SET assignment_id=?,status='running' WHERE sequence=?",
      next.id,
      head.sequence
    )
  ])
}

export async function dispatch(env: GraphEnv, g: Graph): Promise<void> {
  const db = env.DB
  const context = await dispatchContext(db, g, env.ACTION_GRAPH_ENABLED === 'true')
  const { c, now, budgets, used } = context
  const pending = await rows<Assignment>(
    db,
    "SELECT * FROM graph_assignments WHERE graph_id=? AND status='pending' AND available_at<=? ORDER BY CASE role WHEN 'undo' THEN 0 WHEN 'reconcile' THEN 0 WHEN 'grade' THEN 1 WHEN 'project' THEN 1 WHEN 'continue' THEN 1 ELSE 2 END,priority DESC,created_at",
    g.id,
    now
  )
  const weights = await candidateWeights(db, g, pending, now)
  for (const a of pending) a.priority = weights.get(a.id)!.weight
  pending.sort(
    (a, b) => controlRank(a.role) - controlRank(b.role) || b.priority - a.priority || a.id.localeCompare(b.id)
  )
  const candidates = pending.filter((a) => a.role !== 'execute')
  const heap = new MaxHeap<Assignment>((a, b) => a.priority - b.priority || b.id.localeCompare(a.id))
  for (const a of pending.filter((a) => a.role === 'execute')) heap.push(a)
  while (candidates.length || heap.size) {
    const a = candidates.shift() ?? ((budgets.allocations + 1) % 5 === 0 ? heap.popLowest() : heap.pop())!
    const decision = await eligibility(a, context)
    if (!decision.agent) continue
    const agent = decision.agent,
      cost = decision.cost ?? 0,
      recovery = decision.recovery ?? 0
    const task = id(),
      attempt = id(),
      epoch = a.attempt_count + 1
    await commit(db, g, 'dispatched', a.id, { task_id: task, attempt_id: attempt, agent_id: agent }, [
      sql(
        db,
        "INSERT INTO tasks(id,team_id,agent_id,sender_id,subject,status,auto_close,close_steps,created_at) VALUES(?,?,?,?,?,'pending',1,'[]',?)",
        task,
        g.team_id,
        agent,
        g.owner_id,
        `[Graph ${g.id.slice(-8)}] ${a.role}`,
        now
      ),
      sql(
        db,
        "INSERT INTO messages(id,task_id,sender_id,role,type,body,created_at) VALUES(?,?,?,'user','inbox',?,?)",
        id(),
        task,
        g.owner_id,
        a.template,
        now
      ),
      sql(
        db,
        'INSERT INTO graph_attempts(id,assignment_id,task_id,agent_id,epoch,deadline,context_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',
        attempt,
        a.id,
        task,
        agent,
        epoch,
        now + c.policy.deadline_ms,
        await hash(a.input),
        now
      ),
      sql(
        db,
        "UPDATE graph_assignments SET status='running',attempt_count=?,priority=? WHERE id=?",
        epoch,
        a.priority,
        a.id
      ),
      sql(
        db,
        'INSERT INTO graph_reservations(agent_id,attempt_id,graph_id,kind,created_at) VALUES(?,?,?,?,?)',
        agent,
        attempt,
        g.id,
        a.role === 'execute' ? 'execution' : 'control',
        now
      ),
      sql(
        db,
        'UPDATE graph_budgets SET attempts=attempts+1,execution_cost=execution_cost+?,recovery_reserved=recovery_reserved+?,allocations=allocations+? WHERE graph_id=?',
        cost,
        recovery,
        a.role === 'execute' ? 1 : 0,
        g.id
      )
    ])
    await bumpInboxVersion(env, agent)
    budgets.attempts++
    if (['decompose', 'plan', 'merge'].includes(a.role)) context.planningCount++
    budgets.execution_cost += cost
    budgets.recovery_reserved += recovery
    used.push({ agent_id: agent, kind: a.role === 'execute' ? 'execution' : 'control', graph_id: g.id })
    if (a.role === 'execute') {
      context.executions++
      budgets.allocations++ // keeps the every-fifth weak-candidate trial correct within one tick
    }
  }
}

/** Queue ownership survives format repairs and checked continuations, including review. */
const ACTIVE_CONTINUE_WORK = `SELECT json_extract(input,'$.serial_work_id') FROM graph_assignments
  WHERE graph_id=? AND role='continue' AND status IN ('pending','running','review') AND json_extract(input,'$.serial_work_id') IS NOT NULL`
const ACTIVE_REPAIR_WORK = `SELECT CASE WHEN original.role IN ('grade','project','continue')
  THEN COALESCE(json_extract(original.input,'$.serial_work_id'),json_extract(original.input,'$.execution_result_id'),original.id)
  ELSE r.id END FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id
  JOIN graph_assignments original ON original.id=t.assignment_id
  JOIN graph_assignments repair ON repair.parent_id=t.assignment_id
  WHERE repair.graph_id=? AND repair.role='repair' AND repair.status IN ('pending','running','review')
  AND r.status='invalid' AND t.epoch=(SELECT MAX(epoch) FROM graph_attempts WHERE assignment_id=t.assignment_id)`

/** Planning steps are side-effect free, so a blocked/errored one the owner closes by hand is treated as
 * failed: cancel it (and any open repair) and queue a fresh copy. Execution, review and recovery steps
 * are never retried this way — repeating them could repeat a side effect. */
const RETRY_ON_CLOSE: Role[] = ['decompose', 'plan', 'merge']
export async function failAssignment(db: D1Database, g: Graph, assignmentId: string): Promise<void> {
  const a = await sql(
    db,
    "SELECT * FROM graph_assignments WHERE id=? AND graph_id=? AND status IN ('blocked','error')",
    assignmentId,
    g.id
  ).first<Assignment>()
  if (!a || !RETRY_ON_CLOSE.includes(a.role)) return
  const next = await assignment(db, g, a.role, JSON.parse(a.input), {
    node: a.node_id,
    edge: a.edge_id,
    parent: a.parent_id,
    priority: a.priority
  })
  await commit(db, g, 'assignment_failed', a.id, { retry: next.id }, [
    sql(
      db,
      `UPDATE graph_assignments SET status='cancelled',cancel_reason='closed'
       WHERE graph_id=? AND (id=? OR (parent_id=? AND role='repair' AND status IN ('pending','running','review','blocked','error')))`,
      g.id,
      a.id,
      a.id
    ),
    ...next.statements
  ])
}

async function dismissStale(db: D1Database, g: Graph): Promise<number> {
  const stale = await rows<{ id: string }>(
    db,
    `SELECT a.id FROM graph_assignments a WHERE a.graph_id=? AND a.status IN ('blocked','error')
     AND a.role NOT IN ('execute','undo','reconcile','continue')
     AND (a.role='repair' OR EXISTS(SELECT 1 FROM graph_attempts t JOIN graph_results r ON r.attempt_id=t.id
          WHERE t.assignment_id=a.id AND r.status='stale'))`,
    g.id
  )
  const ops: D1PreparedStatement[] = []
  if (stale.length)
    ops.push(
      sql(
        db,
        `UPDATE graph_assignments SET status='cancelled',cancel_reason='dismissed' WHERE graph_id=? AND id IN (${stale.map(() => '?').join(',')})`,
        g.id,
        ...stale.map((a) => a.id)
      )
    )
  // Park blocked/error continuations without retrying them. A live formatting
  // repair still owns the same serial work until its result is resolved.
  // Inspect queue transitions even when there is no assignment noise to dismiss.
  const release = await rows<{ sequence: number }>(
    db,
    `SELECT q.sequence FROM graph_serial_queue q WHERE q.graph_id=? AND q.status='pending'
     AND q.work_id NOT IN (${ACTIVE_CONTINUE_WORK}) AND q.work_id NOT IN (${ACTIVE_REPAIR_WORK}) AND (
       (q.kind='assignment' AND q.work_id IN (SELECT id FROM graph_assignments WHERE graph_id=?
         AND (status IN ('cancelled','expired','accepted','continuation') OR (role='continue' AND status IN ('blocked','error')))))
       OR (q.kind='execution' AND q.work_id IN (SELECT id FROM graph_results WHERE status IN ('stale','invalid','rejected')
         OR (status='accepted' AND json_extract(parsed,'$.outcome')='blocked'))))`,
    g.id,
    g.id,
    g.id,
    g.id
  )
  const reopen = await rows<{ sequence: number }>(
    db,
    `SELECT sequence FROM graph_serial_queue WHERE graph_id=? AND status='done'
     AND (work_id IN (${ACTIVE_CONTINUE_WORK}) OR work_id IN (${ACTIVE_REPAIR_WORK}))
     AND sequence=(SELECT MAX(q.sequence) FROM graph_serial_queue q WHERE q.graph_id=graph_serial_queue.graph_id
       AND q.kind=graph_serial_queue.kind AND q.work_id=graph_serial_queue.work_id)`,
    g.id,
    g.id,
    g.id
  )
  for (const [items, status] of [
    [release, 'done'],
    [reopen, 'pending']
  ] as const)
    for (const q of items)
      ops.push(sql(db, 'UPDATE graph_serial_queue SET status=? WHERE sequence=?', status, q.sequence))
  // Newly cancelled assignment entries are included in the same durable transition.
  if (stale.length)
    ops.push(
      sql(
        db,
        "UPDATE graph_serial_queue SET status='done' WHERE graph_id=? AND kind='assignment' AND work_id IN (SELECT id FROM graph_assignments WHERE graph_id=? AND status='cancelled')",
        g.id,
        g.id
      )
    )
  if (ops.length)
    await commit(
      db,
      g,
      'queue_reconciled',
      null,
      { dismissed: stale.length, released: release.length, reopened: reopen.length },
      ops
    )
  return stale.length
}

/** Inbox tasks of steps that wait for the owner stay in `waiting_input` (pending input) instead of `done`;
 * they return to `done` once the step is answered, cancelled or otherwise no longer needs the owner.
 * Planning/review steps whose result merely went out of date are noise, not owner input, and stay done. */
export async function syncInboxStatus(db: D1Database, g: Graph): Promise<void> {
  const needsOwner = `SELECT t.task_id FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id
    WHERE a.graph_id=? AND a.status IN ('blocked','error') AND a.role!='repair'
    AND NOT EXISTS(SELECT 1 FROM graph_assignments repair WHERE repair.parent_id=a.id AND repair.role='repair' AND repair.status IN ('pending','running','review'))
    AND t.epoch=(SELECT MAX(epoch) FROM graph_attempts WHERE assignment_id=a.id)
    AND (a.role IN ('execute','undo','continue') OR NOT EXISTS(
      SELECT 1 FROM graph_results r WHERE r.attempt_id=t.id AND r.status='stale'))`
  await db.batch([
    sql(db, `UPDATE tasks SET status='waiting_input' WHERE status IN ('done','failed') AND id IN (${needsOwner})`, g.id),
    sql(
      db,
      `UPDATE tasks SET status='done' WHERE status='waiting_input'
       AND id IN (SELECT t.task_id FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=?)
       AND id NOT IN (${needsOwner})`,
      g.id,
      g.id
    )
  ])
}

export async function tick(env: GraphEnv, graphId: string): Promise<void> {
  const g = await graph(env.DB, graphId)
  await processResults(env.DB, g)
  await revalidateReviews(env.DB, g)
  await dismissStale(env.DB, g)
  await advanceGrading(env.DB, g)
  await syncInboxStatus(env.DB, g)
  await dispatch(env, g)
}

async function executedLineage(db: D1Database, graphId: string, first: string | null): Promise<string[]> {
  const lineage = new Set<string>()
  let edge = first
  while (edge && !lineage.has(edge)) {
    lineage.add(edge)
    const previous = await sql(
      db,
      `SELECT a.edge_id FROM graph_edges e
   JOIN graph_nodes n ON n.id=e.from_id JOIN graph_results r ON r.id=n.source_result_id
   JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id
   WHERE e.id=? AND e.graph_id=? AND a.role='execute' AND r.status='accepted'`,
      edge,
      graphId
    ).first<{ edge_id: string | null }>()
    edge = previous?.edge_id ?? null
  }
  return [...lineage]
}

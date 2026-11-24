import { bumpInboxVersion } from '../../inbox_version.js'
import { hash, type Role } from '../contracts.js'
import { dispatchContext, eligibility } from '../eligibility.js'
import { MaxHeap } from '../heap.js'
import { isPlanning, isReview } from '../roles.js'
import { commit, id, rows, sql, type Assignment, type Graph } from '../store.js'
import { candidateWeights } from '../weights.js'

import { type GraphEnv } from './shared.js'


export const controlRank = (role: Role) =>
  role === 'undo' || role === 'reconcile' ? 0 : ['grade', 'project', 'continue'].includes(role) ? 1 : 2

export async function dispatch(env: GraphEnv, g: Graph): Promise<void> {
  const db = env.DB
  // A closed graph's finished attempt keeps its reservation only for its own reconcile. It must
  // not hold the agent (one row per agent) against other graphs, or their dispatch collides on it.
  await sql(
    db,
    `DELETE FROM graph_reservations WHERE graph_id!=?
     AND graph_id IN (SELECT id FROM graphs WHERE status='stopped')
     AND attempt_id IN (SELECT id FROM graph_attempts WHERE status NOT IN ('pending','running'))`,
    g.id
  ).run()
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
        await sessionFraming(db, g, a, agent),
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
    if (isPlanning(a.role)) context.planningCount++
    budgets.execution_cost += cost
    budgets.recovery_reserved += recovery
    used.push({ agent_id: agent, kind: a.role === 'execute' ? 'execution' : 'control', graph_id: g.id })
    if (a.role === 'execute') {
      context.executions++
      budgets.allocations++ // keeps the every-fifth weak-candidate trial correct within one tick
    }
  }
}

/** Skill an agent runs before its first graph step. Read-only roles (grade, project) cannot write the repository,
 * so they skip it. */
export const PREPARE_SKILL = '/tsq-graph-prepare-repo'

/** Run by the daemon, one at a time and each to completion, after an execution result is posted and before the
 * session is closed. */
export const SESSION_END_STEPS = ['/tsq-end-session-learning', '/tsq-memory']

/** The task message for an attempt: the role prompt, preceded by the repo preparation the first time this agent
 * works on the graph (skipped by the read-only grader). */
export async function sessionFraming(db: D1Database, g: Graph, a: Assignment, agentId: string): Promise<string> {
  const first = !(await sql(
    db,
    `SELECT 1 FROM graph_attempts t JOIN graph_assignments x ON x.id=t.assignment_id WHERE x.graph_id=? AND t.agent_id=? LIMIT 1`,
    g.id,
    agentId
  ).first())
  const before =
    first && !isReview(a.role)
      ? `First, before anything else: this is your first step on this graph, so run ${PREPARE_SKILL} (it creates or amends AGENTS.md in the repository root), then continue below.\n\n`
      : ''
  return before + a.template
}

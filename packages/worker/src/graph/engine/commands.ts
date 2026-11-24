import { policy as normalize, type Policy } from '../contracts.js'
import { isReview } from '../roles.js'
import { assignment, commit, configuration, graph, json, rows, sql, type Assignment, type Data, type Result } from '../store.js'
import { annotate, resource } from '../mutations.js'
import { accept } from './accept.js'
import { recoverReview } from './grading.js'
import { abandonAssignment, dismissStale, failAssignment } from './owner.js'
import { resolve } from './results.js'
import { compactOwnerHistory, continuationRoot, executionResources, restartOwnerHistory } from './shared.js'

export async function run(db: D1Database, graphId: string, command: string, body: Data = {}): Promise<void> {
  // 'stopped' is the terminal Closed state: immutable and irreversible, like a Done inbox task.
  if (await sql(db, "SELECT 1 FROM graphs WHERE id=? AND status='stopped'", graphId).first()) {
    if (command === 'stop') return
    throw new Error('Graph is closed and cannot be changed')
  }
  if (command === 'tag' || command === 'link') {
    await annotate(db, graphId, command, body)
    return
  }
  if (command === 'resource') {
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
  if (command === 'retry_review' || command === 'cancel_review') {
    await recoverReview(db, g, String(body.assignment_id), command === 'retry_review', body.user_id as string | undefined)
    return
  }
  if (command === 'fail') {
    await failAssignment(db, g, String(body.assignment_id))
    return
  }
  if (command === 'abandon') {
    await abandonAssignment(db, g, String(body.assignment_id), body.user_id as string | undefined)
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
        "SELECT 1 FROM graph_grading WHERE execution_result_id=? AND status NOT IN ('done','cancelled')",
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
    const { root, missing } = await continuationRoot(db, a, g.id)
    if (missing) throw new Error('Missing continuation ancestor')
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
      (isReview(a.role) ? (previousInput.execution_result_id ?? a.id) : undefined)
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
    const ordinary = "('decompose','plan','merge','execute')"
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
    // Nobody can answer a closed graph: close every inbox task still waiting for the owner.
    ops.push(
      sql(
        db,
        `UPDATE tasks SET status='done',completed_at=? WHERE status='waiting_input'
         AND id IN (SELECT t.task_id FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=?)`,
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

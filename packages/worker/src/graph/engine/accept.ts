import { type Role, verifyGoal } from '../contracts.js'
import { queueDone } from './queue.js'
import { assignment, commit, configuration, id, json, nodeStatements, releaseRecovery, rows, sql, type Assignment, type Data, type Graph, type Result } from '../store.js'
import { assertEvidenceResources, predicateVerified } from './assertions.js'
import { resolve } from './results.js'
import { actionable, compactOwnerHistory, continuationRoot, executedLineage, executionNodes, executionResources, restartOwnerHistory, retryDelay } from './shared.js'

export async function evidenceStatements(
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
          releaseRecovery(db, g.id, Number((input.plan as Data).recovery_cost))
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
          queueDone(db, g.id, 'assignment', input.serial_work_id ?? original.id)
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
      // The stored goal score ranks the candidate; per-goal detail stays in the result itself.
      // Rank by the goal this node moved the most (a milestone counts), not only the far-off root goal.
      const impacts = (d.goal_impacts ?? []) as Data[]
      const rootScore = impacts.length ? Math.max(...impacts.map((i) => Number(i.actual))) : d.goal_score
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
        predicates.every((p) => predicateVerified(observed, p))
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
          releaseRecovery(db, g.id, Number((input.plan as Data).recovery_cost))
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
          queueDone(db, g.id, 'assignment', original.id)
        )
      const found = await sql(
        db,
        'SELECT * FROM graph_assignments WHERE id=?',
        original.parent_id
      ).first<Assignment>()
      if (!found) throw new Error('Missing blocked assignment')
      // A reply to a blocked continue must resume the step that started it, never spawn another
      // continue (that looped: continue -> restart -> continue ...).
      const { root: parent } = await continuationRoot(db, found)
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
        if (d.decision === 'replan') {
          // The owner approved work that the current plan does not cover. Send it back to planning with the
          // approval as input; never make the owner author a plan or look up internal IDs.
          if (parent.role !== 'execute') throw new Error('replan applies only to a reviewed execution plan')
          const old = (JSON.parse(parent.input).plan ?? {}) as Data
          ops.push(sql(db, "UPDATE graph_assignments SET status='cancelled',cancel_reason='replanned' WHERE id=?", parent.id))
          await enqueue('plan', {
            task: {
              title: String(old.title ?? 'Revised plan'),
              description: String(old.description ?? ''),
              body: `Revise the plan to cover the owner-approved work. Previous plan: ${String(old.body ?? '')}`.slice(0, 3999)
            },
            observations: await executionNodes(db, g.id),
            resources: await executionResources(db, g.id),
            feedback: {
              owner_approval: compactOwnerHistory([...((input.prior_user_inputs as string[]) ?? []), String(input.user_input ?? '')]).join('\n\nFollow-up:\n'),
              reason: String(d.reason ?? '')
            }
          })
          break
        }
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
          !predicates.every((p) => predicateVerified(evidence, p))
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
          releaseRecovery(db, g.id, Number(JSON.parse(prior.input).plan.recovery_cost))
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

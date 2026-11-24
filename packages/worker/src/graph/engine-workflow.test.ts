import { graphInboxTask } from './inbox.js'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import {
  db,
  mf,
  env,
  fixture,
  deliver,
  preparedExecution,
  setupGraphHarness,
  teardownGraphHarness,
  restartGraphHarness
} from './test-harness.js'
import { graph, configuration, sql, rows, commit, assignment, nodeStatements, type Assignment, type Result } from './store.js'
import { snapshot } from './snapshot.js'
import { resource } from './mutations.js'
import { maintenance } from './maintenance.js'
import { run, tick, intake, bindStatement, processResults, advanceGrading } from './engine.js'
import { sessionOpen, sessionNotify, sessionClose } from '../routes/daemon.js'
import type { Env } from '../types.js'


beforeAll(setupGraphHarness, 30000)
afterAll(teardownGraphHarness)

describe('graph execution workflow', () => {
  it('intakes notify and close once without letting a duplicate clear a newer session', async () => {
    const { g, agent, team, user } = await fixture()
    const handlerEnv = {
      ...env(),
      GRAPH_COORDINATOR: {
        idFromName: (s: string) => s,
        get: () => ({ command: async () => tick(env(), g.id) })
      }
    } as unknown as Env
    const daemon = { agentId: agent, teamId: team, userId: user, tokenId: 'fixture' }
    const request = (path: string, body: unknown) =>
      new Request('https://fixture.test' + path, { method: 'POST', body: JSON.stringify(body) })
    await sql(db, "INSERT INTO agent_state(agent_id,mode,updated_at) VALUES(?,'idle',0)", agent).run()
    await run(db, g.id, 'run')
    await tick(env(), g.id)
    const attempt = (
      await rows<{ task_id: string }>(db, 'SELECT task_id FROM graph_attempts WHERE agent_id=?', agent)
    )[0]
    const opened = await sessionOpen(
      request('/daemon/session/open', { task_id: attempt.task_id }),
      handlerEnv,
      {},
      daemon
    )
    const session = ((await opened.json()) as { session_id: string }).session_id
    const raw = JSON.stringify({ subgoals: [] })
    const notified = await sessionNotify(
      request('/daemon/session/notify', { session_id: session, message: raw }),
      handlerEnv,
      {},
      daemon
    )
    expect(notified.status).toBe(200)
    const receipt = (await notified.json()) as { message_id: string }
    expect(receipt.message_id).toBeTruthy()
    const nextTask = crypto.randomUUID(),
      nextSession = crypto.randomUUID()
    await db.batch([
      sql(
        db,
        "INSERT INTO tasks(id,team_id,agent_id,sender_id,subject,status,created_at) VALUES(?,?,?,?,'Next','running',0)",
        nextTask,
        team,
        agent,
        user
      ),
      sql(
        db,
        "INSERT INTO sessions(id,task_id,agent_id,status,started_at) VALUES(?,?,?,'running',0)",
        nextSession,
        nextTask,
        agent
      ),
      sql(
        db,
        'UPDATE agent_state SET current_task_id=?,current_session=? WHERE agent_id=?',
        nextTask,
        nextSession,
        agent
      )
    ])
    const closed = await sessionClose(
      request('/daemon/session/close', { session_id: session, final_text: 'wrong duplicate' }),
      handlerEnv,
      {},
      daemon
    )
    expect(closed.status).toBe(200)
    expect(
      (await rows<{ raw: string }>(db, 'SELECT raw FROM graph_results WHERE id=?', receipt.message_id))[0].raw
    ).toBe(raw)
    expect(
      (
        await rows<{ current_session: string }>(
          db,
          'SELECT current_session FROM agent_state WHERE agent_id=?',
          agent
        )
      )[0].current_session
    ).toBe(nextSession)
    expect(await rows(db, 'SELECT id FROM messages WHERE id=?', receipt.message_id)).toHaveLength(1)
  })

  it('serializes real coordinator RPC and replays an alarm from durable project state', async () => {
    const { g, team } = await fixture()
    const call = (command: string) =>
      mf.dispatchFetch('https://fixture.test', {
        method: 'POST',
        body: JSON.stringify({ team, graph: g.id, command })
      })
    const started = await call('run')
    expect(await started.json()).toEqual({ ok: true })
    const controls = await Promise.all([call('pause'), call('stop')])
    for (const response of controls) expect(await response.json()).toEqual({ ok: true })
    const before = (await graph(db, g.id)).version
    await restartGraphHarness('\n// restart coordinator isolate')
    const alarm = await call('alarm')
    expect(await alarm.json()).toEqual({ ok: true })
    // No-op maintenance does not churn graph versions or rebuild embeddings forever.
    expect((await graph(db, g.id)).version).toBe(before)
  })

  it('preserves failed outcomes, verifies undo and only then queues a bounded retry', async () => {
    const { g, agent, ref, assignmentId } = await preparedExecution()
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        outcome: 'failed',
        title: 'Failure',
        description: '',
        body: 'Changed only the declared fixture',
        evidence: [],
        actual_cost: 1
      })
    )
    await tick(env(), g.id)
    expect(
      (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', assignmentId))[0].status
    ).toBe('restoring')
    expect(
      (
        await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='undo'", g.id)
      )[0].status
    ).toBe('pending')
    await sql(
      db,
      'UPDATE graph_attempts SET termination_confirmed_at=? WHERE assignment_id=?',
      Date.now(),
      assignmentId
    ).run()
    await tick(env(), g.id)
    const observation = {
      id: crypto.randomUUID(),
      predicate: 'restored',
      value: 'true',
      scope: 'test',
      observed_at: Date.now(),
      expires_at: Date.now() + 60_000,
      resource_id: ref
    }
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        restored: true,
        title: 'Restored',
        description: '',
        body: 'cfg-v1 verified',
        evidence: [observation]
      })
    )
    await tick(env(), g.id)
    expect(
      (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', assignmentId))[0].status
    ).toBe('pending')
    const nodes = await rows<{ kind: string; title: string }>(
      db,
      'SELECT * FROM graph_nodes WHERE graph_id=?',
      g.id
    )
    expect(nodes.some((n) => n.title === 'Failure')).toBe(true)
    expect(nodes.some((n) => n.kind === 'restoration')).toBe(true)
  })

  it('fences timed-out workers while retaining their reservation for reconciliation', async () => {
    const { g, agent, assignmentId } = await preparedExecution()
    const attempt = (
      await rows<{ id: string; task_id: string }>(
        db,
        'SELECT * FROM graph_attempts WHERE assignment_id=?',
        assignmentId
      )
    )[0]
    const session = crypto.randomUUID(),
      bindings = await bindStatement(db, attempt.task_id, agent, session)
    await db.batch([
      sql(
        db,
        "INSERT INTO sessions(id,task_id,agent_id,status,started_at) VALUES(?,?,?,'running',0)",
        session,
        attempt.task_id,
        agent
      ),
      ...bindings
    ])
    await sql(db, 'UPDATE graph_attempts SET deadline=0 WHERE id=?', attempt.id).run()
    await maintenance(env(), g.id)
    await intake(env(), session, agent, JSON.stringify({ outcome: 'complete' }))
    expect(
      (
        await rows<{ status: string }>(db, 'SELECT status FROM graph_results WHERE attempt_id=?', attempt.id)
      )[0].status
    ).toBe('stale')
    expect(await rows(db, 'SELECT * FROM graph_reservations WHERE attempt_id=?', attempt.id)).toHaveLength(1)
    expect(
      await rows(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='reconcile'", g.id)
    ).toHaveLength(1)
    expect(
      (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', assignmentId))[0].status
    ).toBe('reconciling')
  })

  it('runs a complete reviewed-plan execution and serial grading cycle with evidence', async () => {
    const { g, agent, grader } = await fixture(false, true)
    await resource(db, g.id, {
      title: 'Baseline and observations',
      description: '',
      body: 'Test source',
      visibility: 'execution'
    })
    const source = (
      await rows<{ id: string }>(db, "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='observed'", g.id)
    )[0].id
    const ref = (await rows<{ id: string }>(db, 'SELECT id FROM graph_resources WHERE graph_id=?', g.id))[0]
      .id
    await sql(
      db,
      'INSERT INTO graph_agent_capabilities(agent_id,version,seen_at) VALUES(?,1,?)',
      agent,
      Date.now()
    ).run()
    const privateMilestone = nodeStatements(
      db,
      await graph(db, g.id),
      'milestone',
      { title: 'Private hierarchy only', description: '', body: 'Private milestone body' },
      null
    )
    const unpublished = nodeStatements(
      db,
      await graph(db, g.id),
      'outcome',
      { title: 'Unexecuted proposal', description: '', body: 'Not observed' },
      null
    )
    const inactive = nodeStatements(
      db,
      await graph(db, g.id),
      'observed',
      { title: 'Retired observation', description: '', body: 'Stale' },
      null
    )
    await commit(db, await graph(db, g.id), 'seed_context_boundaries', null, {}, [
      ...privateMilestone.statements,
      ...unpublished.statements,
      ...inactive.statements,
      sql(
        db,
        "INSERT INTO graph_node_states(graph_id,node_id,state,reason,created_at) VALUES(?,?,'deactivated','test',?)",
        g.id,
        inactive.id,
        Date.now()
      )
    ])
    await run(db, g.id, 'run')
    await tick(env(), g.id)
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        subgoals: [{ title: 'Measure', description: '', body: 'Read the source', necessity_confidence: 0.8 }]
      })
    )
    await tick(env(), g.id)
    await deliver(
      g.id,
      agent,
      JSON.stringify({ decision: 'distinct', equivalent_node_id: null, reason: 'Useful milestone' })
    )
    await tick(env(), g.id)
    const planContext = JSON.parse(
      (
        await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='plan'", g.id)
      )[0].input
    )
    expect(planContext.observations.map((n: { id: string }) => n.id)).toEqual([source])
    const action = {
      title: 'Bounded action',
      expected_quality: 0.7,
      description: '',
      body: 'Measure source',
      from_id: source,
      baseline: 'cfg-v1',
      restoration_predicates: ['restored'],
      steps: ['Read source'],
      undo_steps: ['Verify unchanged baseline'],
      cost: 1,
      recovery_cost: 1,
      resource_versions: [ref],
      effects: ['read-only']
    }
    await deliver(g.id, agent, JSON.stringify({ actions: [action] }))
    await tick(env(), g.id)
    const forwardContext = JSON.parse(
      (
        await rows<Assignment>(
          db,
          "SELECT * FROM graph_assignments WHERE graph_id=? AND role='merge' ORDER BY created_at DESC,id DESC",
          g.id
        )
      )[0].input
    )
    expect(forwardContext.existing_states.map((n: { id: string }) => n.id)).toEqual([source])
    await deliver(
      g.id,
      agent,
      JSON.stringify({ decision: 'distinct', equivalent_node_id: null, reason: 'New bounded action' })
    )
    await tick(env(), g.id)
    const before = await snapshot(db, await graph(db, g.id))
    expect((before.assignments as Assignment[]).find((a) => a.role === 'execute')?.status).toBe('running')
    const evidence = {
      id: crypto.randomUUID(),
      predicate: 'verified',
      value: 'true',
      scope: 'test',
      observed_at: Date.now(),
      expires_at: Date.now() + 60_000,
      resource_id: ref
    }
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        outcome: 'complete',
        title: 'Observed',
        description: '',
        body: 'Observation',
        evidence: [evidence],
        actual_cost: 1
      })
    )
    await tick(env(), g.id)
    await deliver(
      g.id,
      grader,
      JSON.stringify({ local_score: 0.8, evidence_ids: [evidence.id], reason: 'Valid measurement' })
    )
    await tick(env(), g.id)
    await deliver(
      g.id,
      grader,
      JSON.stringify({ goal_score: 0.7, evidence_ids: [evidence.id], reason: 'Supports predicate' })
    )
    await tick(env(), g.id)
    const final = await snapshot(db, await graph(db, g.id))
    expect(final.goal_verification).toBe('true')
    expect(final.evaluations).toHaveLength(2)
    const executionResult = (final.results as Result[]).find(
      (r) => JSON.parse(r.parsed ?? '{}').outcome === 'complete'
    )!
    await run(db, g.id, 'regrade', { execution_result_id: executionResult.id })
    await tick(env(), g.id)
    await deliver(
      g.id,
      grader,
      JSON.stringify({ local_score: 0.2, evidence_ids: [evidence.id], reason: 'Revised quality' })
    )
    await tick(env(), g.id)
    await deliver(
      g.id,
      grader,
      JSON.stringify({ goal_score: 0.1, evidence_ids: [evidence.id], reason: 'Revised alignment' })
    )
    await tick(env(), g.id)
    const revised = await snapshot(db, await graph(db, g.id))
    expect(revised.evaluations).toHaveLength(4)
    expect(new Set((revised.evaluations as { evidence_id: string }[]).map((e) => e.evidence_id)).size).toBe(1)

    expect((final.grading as { status: string }[]).every((x) => x.status === 'done')).toBe(true)
    expect(
      (final.assignments as Assignment[]).filter((a) => a.role === 'grade' || a.role === 'project')
    ).toHaveLength(2)
  })

  it('rolls back a competing version claim without partial writes', async () => {
    const { g } = await fixture()
    const stale = { ...g }
    await commit(db, g, 'first', null, {}, [])
    await expect(
      commit(db, stale, 'second', null, {}, [sql(db, "UPDATE graphs SET title='incorrect' WHERE id=?", g.id)])
    ).rejects.toThrow()
    expect((await graph(db, g.id)).title).toBe('Goal')
  })
  it.each(['grade', 'project'])('parks an exhausted %s, runs independent work and retries without losing history', async (role) => {
    const { g, agent, grader, user } = await preparedExecution()
    await deliver(g.id, agent, JSON.stringify({ outcome: 'complete', title: 'Measured', description: '', body: '', evidence: [], actual_cost: 0 }))
    await tick(env(), g.id)
    if (role === 'project') {
      await deliver(g.id, grader, JSON.stringify({ local_score: 0, evidence_ids: [], reason: 'No measured change' }))
      await tick(env(), g.id)
    }
    const failed = (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE graph_id=? AND role=?', g.id, role))[0]
    for (let i = 0; i < failed.max_attempts; i++) {
      await sql(db, "UPDATE graph_attempts SET deadline=0 WHERE assignment_id=? AND status IN ('pending','running')", failed.id).run()
      await maintenance(env(), g.id)
      if (i + 1 < failed.max_attempts) {
        await sql(db, 'UPDATE graph_assignments SET available_at=0 WHERE id=?', failed.id).run()
        await tick(env(), g.id)
      }
    }
    await tick(env(), g.id)
    const [grading] = await rows<{ sequence: number; status: string; execution_result_id: string }>(db, 'SELECT * FROM graph_grading WHERE assignment_id=?', failed.id)
    expect(grading.status).toBe('blocked')
    expect(await rows(db, "SELECT * FROM graph_serial_queue WHERE work_id=? AND status='pending'", grading.execution_result_id)).toHaveLength(0)
    expect(await rows(db, 'SELECT * FROM graph_attempts WHERE assignment_id=?', failed.id)).toHaveLength(3)
    const snap = await snapshot(db, await graph(db, g.id))
    expect((snap.waiting as Record<string, { code: string }>)[failed.id].code).toBe('review_failed')
    const [last] = await rows<{ task_id: string }>(db, 'SELECT task_id FROM graph_attempts WHERE assignment_id=? ORDER BY epoch DESC LIMIT 1', failed.id)
    expect((await graphInboxTask({ DB: db, ACTION_GRAPH_ENABLED: 'true' }, last.task_id, user))?.can_reply).toBe(false)
    // A later serial assignment can dispatch even though the failed grade is still incomplete.
    const current = await graph(db, g.id)
    const later = await assignment(db, current, 'project', { operation: 'decomposition_review', evidence: [] })
    await commit(db, current, 'later_review', later.id, {}, [...later.statements,
      sql(db, "INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,'assignment',?,?)", g.id, later.id, Date.now())])
    await tick(env(), g.id)
    expect((await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', later.id))[0].status).toBe('running')
    // A retry is idempotent, appends fresh work, and never resets or deletes old attempts.
    await run(db, g.id, 'retry_review', { assignment_id: failed.id, user_id: user })
    await run(db, g.id, 'retry_review', { assignment_id: failed.id, user_id: user })
    const retries = await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE parent_id=? AND role=?', failed.id, role)
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({ status: 'pending', attempt_count: 0, input: failed.input })
    expect((await rows<{ assignment_id: string }>(db, 'SELECT assignment_id FROM graph_grading WHERE sequence=?', grading.sequence))[0].assignment_id).toBe(retries[0].id)
    expect(await rows(db, "SELECT * FROM graph_serial_queue WHERE work_id=? AND status='pending'", grading.execution_result_id)).toHaveLength(1)
    expect(await rows(db, 'SELECT * FROM graph_attempts WHERE assignment_id=?', failed.id)).toHaveLength(3)
    expect(await rows(db, 'SELECT * FROM graph_evaluations WHERE source_result_id IN (SELECT r.id FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.assignment_id=?)', failed.id)).toHaveLength(0)
    await deliver(g.id, grader, JSON.stringify({ goal_score: 0, evidence_ids: [], reason: 'No progress' }))
    await tick(env(), g.id)
    expect((await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', retries[0].id))[0].status).toBe('running')
    await deliver(g.id, grader, JSON.stringify({ [role === 'grade' ? 'local_score' : 'goal_score']: 0, evidence_ids: [], reason: 'Verified review' }))
    await tick(env(), g.id)
    expect((await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', retries[0].id))[0].status).toBe('accepted')
    const [finished] = await rows<{ stage: string; status: string }>(db, 'SELECT * FROM graph_grading WHERE sequence=?', grading.sequence)
    expect(finished.stage).toBe(role === 'grade' ? 'project' : 'done')
  }, 30_000)

  it('cancels a failed review without deactivating its target or inventing a grade', async () => {
    const { g, agent } = await preparedExecution()
    await deliver(g.id, agent, JSON.stringify({ outcome: 'complete', title: 'Measured', description: '', body: '', evidence: [], actual_cost: 0 }))
    await tick(env(), g.id)
    const [review] = await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='grade'", g.id)
    await expect(run(db, g.id, 'cancel_review', { assignment_id: review.id })).rejects.toThrow('blocked or failed')
    await db.batch([
      sql(db, "UPDATE graph_attempts SET status='timeout' WHERE assignment_id=?", review.id),
      sql(db, "UPDATE graph_assignments SET status='error' WHERE id=?", review.id)
    ])
    await run(db, g.id, 'cancel_review', { assignment_id: review.id })
    await run(db, g.id, 'cancel_review', { assignment_id: review.id })
    expect((await rows<{ status: string }>(db, 'SELECT status FROM graph_grading WHERE assignment_id=?', review.id))[0].status).toBe('cancelled')
    expect(await rows(db, "SELECT * FROM graph_node_states WHERE graph_id=? AND state='deactivated'", g.id)).toHaveLength(0)
    expect(await rows(db, 'SELECT * FROM graph_evaluations WHERE graph_id=?', g.id)).toHaveLength(0)
    const other = await fixture()
    await expect(run(db, other.g.id, 'retry_review', { assignment_id: review.id })).rejects.toThrow('blocked or failed')
  })

  it('holds the FIFO head until its execution result is accepted', async () => {
    const { g, agent } = await fixture()
    await run(db, g.id, 'run')
    await tick(env(), g.id)
    const { attempt } = await deliver(g.id, agent, '{"subgoals":[]}')
    const result = (await rows<Result>(db, 'SELECT * FROM graph_results WHERE attempt_id=?', attempt.id))[0]
    await sql(
      db,
      'INSERT INTO graph_grading(graph_id,execution_result_id,created_at) VALUES(?,?,?)',
      g.id,
      result.id,
      Date.now()
    ).run()
    await processResults(db, await graph(db, g.id))
    await advanceGrading(db, await graph(db, g.id))
    expect(
      await rows(db, "SELECT id FROM graph_assignments WHERE graph_id=? AND role='grade'", g.id)
    ).toHaveLength(0)
  })

  it('creates and decomposes, requiring exact approval and deduplicating delivery', async () => {
    const { g, user, agent } = await fixture()
    await run(db, g.id, 'run')
    await tick(env(), g.id)
    const { session } = await deliver(
      g.id,
      agent,
      JSON.stringify({
        subgoals: [
          { title: 'Local task', description: '', body: 'Measure the baseline', necessity_confidence: 0.8 }
        ]
      })
    )
    await intake(env(), session, agent, 'duplicate must not overwrite')
    await processResults(db, await graph(db, g.id))
    const result = (
      await rows<Result>(
        db,
        `SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=?`,
        g.id
      )
    )[0]
    expect(result.status).toBe('review')
    expect((await snapshot(db, await graph(db, g.id))).nodes).toHaveLength(2)
    const c = await configuration(db, await graph(db, g.id))
    await expect(
      run(db, g.id, 'review', {
        result_id: result.id,
        output_hash: 'wrong',
        config_version: c.version,
        verdict: 'accept',
        user_id: user
      })
    ).rejects.toThrow('conflict')
    await run(db, g.id, 'review', {
      result_id: result.id,
      output_hash: result.output_hash,
      config_version: c.version,
      verdict: 'accept',
      user_id: user
    })
    await run(db, g.id, 'review', {
      result_id: result.id,
      output_hash: result.output_hash,
      config_version: c.version,
      verdict: 'accept',
      user_id: user
    })
    expect((await snapshot(db, await graph(db, g.id))).nodes).toHaveLength(2)
    expect(await rows(db, 'SELECT * FROM graph_proposals WHERE graph_id=?', g.id)).toHaveLength(1)
    expect(await rows(db, 'SELECT * FROM graph_approvals WHERE result_id=?', result.id)).toHaveLength(1)
    expect(
      await rows(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='merge'", g.id)
    ).toHaveLength(1)
  })

  it('rejects a wrong agent and repeat session open', async () => {
    const { g, agent } = await fixture()
    await run(db, g.id, 'run')
    await tick(env(), g.id)
    const task = (
      await rows<{ task_id: string }>(db, 'SELECT task_id FROM graph_attempts WHERE agent_id=?', agent)
    )[0]
    await expect(bindStatement(db, task.task_id, 'wrong', crypto.randomUUID())).rejects.toThrow('Unexpected')
    await deliver(g.id, agent, '{}')
    await expect(bindStatement(db, task.task_id, agent, crypto.randomUUID())).rejects.toThrow('Unexpected')
  })

  it('does not advance the graph on stale delivery', async () => {
    const { g, agent } = await fixture(false)
    await run(db, g.id, 'run')
    await tick(env(), g.id)
    await deliver(g.id, agent, '{"subgoals":[]}', async () => {
      await sql(db, 'UPDATE graph_attempts SET deadline=0 WHERE agent_id=?', agent).run()
    })
    await processResults(db, await graph(db, g.id))
    const result = await sql(
      db,
      `SELECT r.status FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.agent_id=?`,
      agent
    ).first<{ status: string }>()
    expect(result?.status).toBe('stale')
  })
})

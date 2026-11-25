import { create as inboxReply } from '../routes/messages.js'
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
} from './test-harness.js'
import { graph, configuration, sql, rows, assignment, nodeStatements, type Assignment, type Result } from './store.js'
import { resource } from './mutations.js'
import { materialize, embeddingChunks } from './outbox.js'
import { search } from './search.js'
import { run, tick, bindStatement, processResults, sessionFraming } from './engine.js'
import { handle as graphRoute } from '../routes/graphs.js'
import { sessionNotify, sessionClose } from '../routes/daemon.js'
import type { Env } from '../types.js'


beforeAll(setupGraphHarness, 30000)
afterAll(teardownGraphHarness)

describe('graph inbox, review and access', () => {
  it('closes inbox tasks waiting for the owner when the graph is closed and never reopens them', async () => {
    const { g, agent, assignmentId } = await preparedExecution()
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        outcome: 'blocked',
        title: 'Need input',
        description: '',
        body: 'Please provide the fixture value',
        evidence: [],
        actual_cost: 0,
        needs_input: {
          title: 'Fixture value',
          fields: [{ id: 'value', type: 'text', label: 'Which value?', required: true }]
        }
      })
    )
    await tick(env(), g.id)
    const attempt = (
      await rows<{ task_id: string }>(db, 'SELECT * FROM graph_attempts WHERE assignment_id=?', assignmentId)
    )[0]
    const status = async () =>
      (await rows<{ status: string }>(db, 'SELECT status FROM tasks WHERE id=?', attempt.task_id))[0].status
    expect(await status()).toBe('waiting_input')
    await run(db, g.id, 'stop')
    expect(await status()).toBe('done')
    await tick(env(), g.id)
    expect(await status()).toBe('done')
  })

  it('routes an owner inbox reply through continuation atomically without reopening execution', async () => {
    const { g, agent, user, team, assignmentId } = await preparedExecution()
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        outcome: 'blocked',
        title: 'Need input',
        description: '',
        body: 'Please provide the fixture value',
        evidence: [],
        actual_cost: 0,
        needs_input: {
          title: 'Fixture value',
          fields: [{ id: 'value', type: 'text', label: 'Which value?', required: true }]
        }
      })
    )
    await tick(env(), g.id)
    const attempt = (
      await rows<{ task_id: string }>(db, 'SELECT * FROM graph_attempts WHERE assignment_id=?', assignmentId)
    )[0]
    // Even a failed terminal session must have an input path when the graph still needs the owner.
    await sql(db, "UPDATE tasks SET status='failed' WHERE id=?", attempt.task_id).run()
    await tick(env(), g.id)
    expect(
      (await rows<{ status: string }>(db, 'SELECT status FROM tasks WHERE id=?', attempt.task_id))[0].status
    ).toBe('waiting_input')
    const bridged = {
      ...env(),
      GRAPH_COORDINATOR: {
        idFromName: () => team,
        get: () => ({
          command: async (id: string, command: string, body: Record<string, unknown>) =>
            run(db, id, command, body)
        })
      }
    } as unknown as Env
    const context = await graphInboxTask(bridged, attempt.task_id, user)
    expect(context).toMatchObject({ can_reply: true, can_manage: true, latest: true })
    // A finished session cannot take a reply.
    await sql(db, "UPDATE tasks SET status='done' WHERE id=?", attempt.task_id).run()
    expect(await graphInboxTask(bridged, attempt.task_id, user)).toMatchObject({ can_reply: false })
    await sql(db, "UPDATE tasks SET status='waiting_input' WHERE id=?", attempt.task_id).run()
    const request = (body: Record<string, unknown>) =>
      new Request(`https://fixture.test/tasks/${attempt.task_id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    const auth = { uid: user, userId: user, email: 'owner@test.com', plan: 'pro' as const }
    const member = crypto.randomUUID()
    await db.batch([
      sql(
        db,
        'INSERT INTO users(id,firebase_uid,email,created_at) VALUES(?,?,?,0)',
        member,
        member,
        member + '@test.com'
      ),
      sql(db, "INSERT INTO team_members(team_id,user_id,role,joined_at) VALUES(?,?,'member',0)", team, member)
    ])
    expect(
      (
        await inboxReply(
          request({ body: 'Unauthorized' }),
          bridged,
          {},
          { ...auth, uid: member, userId: member }
        )
      ).status
    ).toBe(403)
    expect(
      (await inboxReply(request({ body: 'Delayed', scheduled_at: Date.now() + 60_000 }), bridged, {}, auth))
        .status
    ).toBe(400)
    const response = await inboxReply(request({ body: 'Use value 42' }), bridged, {}, auth)
    expect(response.status).toBe(201)
    expect(
      await rows(
        db,
        "SELECT * FROM messages WHERE task_id=? AND role='user' AND body='Use value 42'",
        attempt.task_id
      )
    ).toHaveLength(1)
    const continued = await rows<Assignment>(
      db,
      "SELECT * FROM graph_assignments WHERE parent_id=? AND role='continue'",
      assignmentId
    )
    expect(continued).toHaveLength(1)
    expect(JSON.parse(continued[0].input).user_input).toBe('Use value 42')
    expect(
      (await rows<{ status: string }>(db, 'SELECT status FROM tasks WHERE id=?', attempt.task_id))[0].status
    ).toBe('waiting_input')
    expect(
      (await inboxReply(request({ body: 'Duplicate' }), bridged, {}, auth)).status
    ).toBeGreaterThanOrEqual(400)
    expect(
      await rows(db, "SELECT * FROM graph_assignments WHERE parent_id=? AND role='continue'", assignmentId)
    ).toHaveLength(1)
  })

  it('keeps an execution repair in the queue and grades its accepted result exactly once', async () => {
    const { g, agent, assignmentId } = await preparedExecution()
    await deliver(g.id, agent, 'not valid structured output')
    await tick(env(), g.id)
    const repair = (
      await rows<Assignment>(
        db,
        "SELECT * FROM graph_assignments WHERE parent_id=? AND role='repair'",
        assignmentId
      )
    )[0]
    expect(repair.status).toBe('running')
    // A legacy/manual dismissal must not strand this still-active repair.
    await sql(db, "UPDATE graph_serial_queue SET status='done' WHERE graph_id=?", g.id).run()
    await tick(env(), g.id)
    expect(
      await rows(db, "SELECT * FROM graph_serial_queue WHERE graph_id=? AND status='pending'", g.id)
    ).toHaveLength(1)
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        outcome: 'complete',
        title: 'Repaired',
        description: '',
        body: '',
        evidence: [],
        actual_cost: 0
      })
    )
    await tick(env(), g.id)
    await tick(env(), g.id)
    const grades = await rows<Assignment>(
      db,
      "SELECT * FROM graph_assignments WHERE graph_id=? AND role='grade'",
      g.id
    )
    expect(grades).toHaveLength(1)
    expect(grades[0].status).toBe('running')
    const repaired = (
      await rows<Result>(
        db,
        'SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.assignment_id=?',
        repair.id
      )
    )[0]
    expect(JSON.parse(grades[0].input).execution_result_id).toBe(repaired.id)
  })

  it('parks owner-blocked execution while unrelated reviews dispatch', async () => {
    const { g, agent } = await preparedExecution()
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        outcome: 'blocked',
        title: 'Approval',
        description: '',
        body: '',
        evidence: [],
        actual_cost: 0
      })
    )
    await tick(env(), g.id)
    const review = await assignment(db, await graph(db, g.id), 'project', {
      operation: 'decomposition_review',
      hierarchy: [],
      evidence: []
    })
    await db.batch([
      ...review.statements,
      sql(
        db,
        "INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,'assignment',?,?)",
        g.id,
        review.id,
        Date.now()
      )
    ])
    await tick(env(), g.id)
    expect(
      (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', review.id))[0].status
    ).toBe('running')
  })

  it.each(['blocked', 'error'])('parks a %s continuation without retrying it or blocking later reviews', async (status) => {
    const { g } = await fixture(false)
    const original = await assignment(db, g, 'execute', { plan: {} })
    const continuation = await assignment(db, g, 'continue', { original_role: 'execute' }, { parent: original.id })
    const review = await assignment(db, g, 'project', { operation: 'decomposition_review', hierarchy: [], evidence: [] })
    await db.batch([
      ...original.statements, ...continuation.statements, ...review.statements,
      sql(db, "UPDATE graph_assignments SET status='continuation' WHERE id=?", original.id),
      sql(db, 'UPDATE graph_assignments SET status=? WHERE id=?', status, continuation.id),
      sql(db, "INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,'assignment',?,0)", g.id, continuation.id),
      sql(db, "INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,'assignment',?,1)", g.id, review.id)
    ])
    await tick(env(), g.id)
    expect((await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', continuation.id))[0].status).toBe(status)
    expect((await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', review.id))[0].status).toBe('running')
    expect(await rows(db, 'SELECT * FROM graph_attempts WHERE assignment_id=?', continuation.id)).toHaveLength(0)
    // A later owner answer still creates a checked continuation in the queue.
    await run(db, g.id, 'input', { assignment_id: continuation.id, message: 'Check the baseline again' })
    const followup = (await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE parent_id=? AND role='continue'", continuation.id))[0]
    expect(await rows(db, "SELECT * FROM graph_serial_queue WHERE work_id=? AND status='pending'", followup.id)).toHaveLength(1)
  })

  it('delivers later owner decisions to queued work and summarizes only graphs in the project', async () => {
    const { g, agent } = await fixture(false)
    const other = await fixture(false)
    const siblingId = crypto.randomUUID()
    await sql(db, `INSERT INTO graphs(id,team_id,owner_id,title,description,body,start_state,status,created_at,updated_at)
      SELECT ?,team_id,owner_id,'Private sibling goal','','','','paused',0,0 FROM graphs WHERE id=?`, siblingId, g.id).run()
    const planner = await assignment(db, g, 'plan', { task: 'Plan buyer interviews',
      attempted_actions: { actions: Array.from({ length: 1200 }, (_, i) => ({ title: 'Previous action ' + i })) } })
    const executor = await assignment(db, g, 'execute', { plan: { title: 'Run interviews using owner approvals' } })
    const backward = await assignment(db, g, 'merge', { direction: 'backward' })
    await db.batch([...planner.statements, ...executor.statements, ...backward.statements])
    async function answer(graphId: string, role: 'execute' | 'project', message: string) {
      const a = await assignment(db, await graph(db, graphId), role, {})
      await db.batch([...a.statements, sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", a.id)])
      await run(db, graphId, 'input', { assignment_id: a.id, message })
    }
    await answer(g.id, 'execute', 'approval_response:\n  title: Launch pricing\n  answers:\n    interviews: "$49, $79, $99"\n    production: "$79 final"')
    await answer(g.id, 'project', 'Private grading rationale')
    await answer(other.g.id, 'execute', 'Unrelated project decision')
    async function frame(id: string) {
      const a = (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', id))[0]
      return sessionFraming(db, g, a, agent)
    }
    for (const id of [planner.id, executor.id]) {
      const message = await frame(id)
      expect(message.split('$49, $79, $99')).toHaveLength(2)
      expect(message).toContain('$79 final')
      expect(message).not.toContain('Private grading rationale')
      expect(message).not.toContain('Unrelated project decision')
      expect(message.length).toBeLessThanOrEqual(16000)
    }
    const planMessage = await frame(planner.id)
    expect(planMessage).toContain(siblingId)
    expect(planMessage).toContain('"paused":1')
    expect(planMessage).not.toContain(other.g.id)
    expect(planMessage).not.toContain('Private sibling goal')
    const backwardMessage = await frame(backward.id)
    expect(backwardMessage).toContain(siblingId)
    expect(backwardMessage).not.toContain('$79 final')
  })

  it('frames a first step with repo preparation and execution steps with the end-of-session skills', async () => {
    const { g, agent } = await fixture(false)
    const ex = await assignment(db, g, 'execute', { plan: {} })
    const pl = await assignment(db, g, 'plan', {})
    const gr = await assignment(db, g, 'grade', {})
    await db.batch([...ex.statements, ...pl.statements, ...gr.statements])
    const row = async (id: string) => (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', id))[0]
    const first = await sessionFraming(db, g, await row(ex.id), agent)
    expect(first.startsWith('First, before anything else')).toBe(true)
    expect(first).toContain('/tsq-graph-prepare-repo')
    // The end-of-session skills are run by the daemon after the result, not asked for in the prompt.
    expect(first).not.toContain('/tsq-end-session')
    // Planning steps get preparation; the read-only grader gets none.
    const plan = await sessionFraming(db, g, await row(pl.id), agent)
    expect(plan).toContain('/tsq-graph-prepare-repo')
    expect(plan).not.toContain('/tsq-end-session')
    expect(await sessionFraming(db, g, await row(gr.id), agent)).not.toContain('/tsq-')
    // Once the agent has worked on the graph, preparation is not asked for again.
    await db.batch([
      sql(db, "INSERT INTO tasks(id,team_id,agent_id,sender_id,subject,status,created_at) SELECT 't1',team_id,?,owner_id,'x','pending',0 FROM graphs WHERE id=?", agent, g.id),
      sql(db, "INSERT INTO graph_attempts(id,assignment_id,task_id,agent_id,epoch,deadline,created_at) VALUES('at1',?,'t1',?,1,0,0)", pl.id, agent)
    ])
    const later = await sessionFraming(db, g, await row(ex.id), agent)
    expect(later).not.toContain('/tsq-graph-prepare-repo')
  })

  it('keeps an execution session open for its end-of-session steps and closes it only when the daemon does', async () => {
    const { g, agent, team, user } = await fixture(false)
    const handlerEnv = {
      ...env(),
      GRAPH_COORDINATOR: { idFromName: (s: string) => s, get: () => ({ command: async () => undefined }) }
    } as unknown as Env
    const daemon = { agentId: agent, teamId: team, userId: user, tokenId: 'fixture' }
    const post = (path: string, body: unknown) =>
      new Request('https://fixture.test' + path, { method: 'POST', body: JSON.stringify(body) })
    await sql(db, "INSERT INTO agent_state(agent_id,mode,updated_at) VALUES(?,'idle',0)", agent).run()
    const open = async (hold: boolean) => {
      const ex = await assignment(db, g, 'execute', { plan: {} })
      const task = crypto.randomUUID(),
        attempt = crypto.randomUUID(),
        session = crypto.randomUUID()
      await db.batch([
        ...ex.statements,
        sql(db, "UPDATE graph_assignments SET status='running',attempt_count=1 WHERE id=?", ex.id),
        sql(db, "INSERT INTO tasks(id,team_id,agent_id,sender_id,subject,status,created_at) VALUES(?,?,?,?,'x','running',0)", task, g.team_id, agent, user),
        sql(db, "INSERT INTO graph_attempts(id,assignment_id,task_id,agent_id,epoch,deadline,created_at) VALUES(?,?,?,?,1,?,0)", attempt, ex.id, task, agent, Date.now() + 600_000)
      ])
      await db.batch([
        sql(db, "INSERT INTO sessions(id,task_id,agent_id,status,started_at) VALUES(?,?,?,'running',0)", session, task, agent),
        sql(db, "UPDATE agent_state SET current_task_id=?,current_session=?,mode='running' WHERE agent_id=?", task, session, agent),
        ...(await bindStatement(db, task, agent, session))
      ])
      return { task, session, hold }
    }
    const state = async (t: { task: string; session: string }) => ({
      session: (await rows<{ status: string }>(db, 'SELECT status FROM sessions WHERE id=?', t.session))[0].status,
      task: (await rows<{ status: string }>(db, 'SELECT status FROM tasks WHERE id=?', t.task))[0].status,
      busy: (await rows<{ current_session: string | null }>(db, 'SELECT current_session FROM agent_state WHERE agent_id=?', agent))[0].current_session === t.session
    })

    // A daemon that cannot run the steps gets the old behaviour: the session ends with the result.
    const legacy = await open(false)
    const old = await sessionNotify(post('/daemon/session/notify', { session_id: legacy.session, message: 'outcome: "complete"' }), handlerEnv, {}, daemon)
    expect(await old.json()).toMatchObject({ close: true })
    expect(await state(legacy)).toEqual({ session: 'closed', task: 'done', busy: false })

    // A daemon that can: the result is recorded, the steps are returned, and the session stays open and busy.
    const held = await open(true)
    const res = await sessionNotify(post('/daemon/session/notify', { session_id: held.session, message: 'outcome: "complete"', close_steps: true }), handlerEnv, {}, daemon)
    expect(await res.json()).toMatchObject({ close: false, close_steps: ['/tsq-end-session-learning', '/tsq-memory'], graph_result: true })
    expect(await state(held)).toEqual({ session: 'running', task: 'running', busy: true })
    expect(await rows(db, "SELECT 1 FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.task_id=? AND t.status='completed'", held.task)).toHaveLength(1)

    // After the last step the daemon closes the session: now it ends and the agent is freed.
    const closed = await sessionClose(post('/daemon/session/close', { session_id: held.session, status: 'closed', final_text: 'skill output' }), handlerEnv, {}, daemon)
    expect(await closed.json()).toMatchObject({ close: true })
    expect(await state(held)).toEqual({ session: 'closed', task: 'done', busy: false })
    // The skills' output never replaces the recorded result.
    expect(await rows(db, "SELECT raw FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.task_id=?", held.task)).toEqual([{ raw: 'outcome: "complete"' }])
  })

  it('abandons a blocked continuation chain and releases the queue, reservations and node', async () => {
    const { g } = await fixture(false)
    const node = nodeStatements(db, g, 'milestone', { title: 'Path', description: '', body: '' }, null)
    await db.batch(node.statements)
    const original = await assignment(db, g, 'execute', { plan: {} }, { node: node.id })
    const continuation = await assignment(db, g, 'continue', { original_role: 'execute' }, { parent: original.id })
    const review = await assignment(db, g, 'project', { operation: 'decomposition_review', hierarchy: [], evidence: [] })
    await db.batch([
      ...original.statements, ...continuation.statements, ...review.statements,
      sql(db, "UPDATE graph_assignments SET status='continuation' WHERE id=?", original.id),
      sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", continuation.id),
      sql(db, "INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,'assignment',?,0)", g.id, continuation.id)
    ])
    await run(db, g.id, 'abandon', { assignment_id: continuation.id })
    const status = async (id: string) => (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', id))[0]
    expect((await status(continuation.id)).status).toBe('cancelled')
    expect((await status(original.id)).status).toBe('cancelled')
    expect(await rows(db, "SELECT * FROM graph_serial_queue WHERE work_id=? AND status='pending'", continuation.id)).toHaveLength(0)
    const events = await rows<{ data: string }>(db, "SELECT data FROM graph_events WHERE graph_id=? AND kind='assignment_abandoned'", g.id)
    expect(events).toHaveLength(1)
    expect(JSON.parse(events[0].data).side_effects_verified).toBe(false)
    expect(
      await rows(db, "SELECT * FROM graph_node_states WHERE node_id=? AND state='deactivated' AND reason='abandoned'", node.id)
    ).toHaveLength(1)
    // Only blocked or errored steps can be abandoned.
    await expect(run(db, g.id, 'abandon', { assignment_id: review.id })).rejects.toThrow('blocked assignment')
  })

  it('keeps a continuation formatting repair at its original assignment queue position', async () => {
    const { g, agent } = await fixture(false)
    const original = await assignment(db, g, 'execute', { plan: {} })
    const continuation = await assignment(db, g, 'continue', { original_role: 'execute' }, { parent: original.id })
    const review = await assignment(db, g, 'project', { operation: 'decomposition_review', hierarchy: [], evidence: [] })
    await db.batch([
      ...original.statements, ...continuation.statements, ...review.statements,
      sql(db, "UPDATE graph_assignments SET status='continuation' WHERE id=?", original.id),
      sql(db, "INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,'assignment',?,0)", g.id, continuation.id),
      sql(db, "INSERT INTO graph_serial_queue(graph_id,kind,work_id,created_at) VALUES(?,'assignment',?,1)", g.id, review.id)
    ])
    await tick(env(), g.id)
    await deliver(g.id, agent, 'not structured output')
    await tick(env(), g.id)
    const repair = (await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE parent_id=? AND role='repair'", continuation.id))[0]
    expect(repair.status).toBe('running')
    expect((await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', review.id))[0].status).toBe('pending')
    await sql(db, "UPDATE graph_serial_queue SET status='done' WHERE work_id=?", continuation.id).run()
    await tick(env(), g.id)
    expect(await rows(db, "SELECT * FROM graph_serial_queue WHERE work_id=? AND status='pending'", continuation.id)).toHaveLength(1)
  })

  it('keeps each repeated continuation approval answerable and restarts only the original role', async () => {
    const { g, agent, grader, user, assignmentId } = await preparedExecution()
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        outcome: 'blocked',
        title: 'Need approval',
        description: '',
        body: '',
        evidence: [],
        actual_cost: 0
      })
    )
    await tick(env(), g.id)
    await run(db, g.id, 'input', { assignment_id: assignmentId, message: 'First approval' })
    let current = assignmentId
    for (let i = 0; i < 2; i++) {
      await tick(env(), g.id)
      const next = (
        await rows<Assignment>(
          db,
          "SELECT * FROM graph_assignments WHERE parent_id=? AND role='continue'",
          current
        )
      )[0]
      expect(next.status).toBe('running')
      const { attempt } = await deliver(
        g.id,
        grader,
        JSON.stringify({
          decision: 'blocked',
          reason: 'Need one more answer',
          checkpoint_verified: false,
          baseline_unchanged: true,
          termination_verified: true,
          needs_input: {
            title: `Approval ${i + 2}`,
            fields: [{ id: 'value', type: 'text', label: 'Value', required: true }]
          }
        })
      )
      await tick(env(), g.id)
      expect(await graphInboxTask(env(), attempt.task_id, user)).toMatchObject({ can_reply: true })
      await run(db, g.id, 'input', { assignment_id: next.id, message: `Approval answer ${i + 2}` })
      current = next.id
    }
    await tick(env(), g.id)
    const last = (
      await rows<Assignment>(
        db,
        "SELECT * FROM graph_assignments WHERE parent_id=? AND role='continue'",
        current
      )
    )[0]
    expect(JSON.parse(last.input)).toMatchObject({
      original_role: 'execute',
      prior_user_inputs: ['First approval', 'Approval answer 2']
    })
    expect(JSON.parse(last.input).previous.assignment).toBeUndefined()
    await sql(
      db,
      'UPDATE graph_attempts SET termination_confirmed_at=? WHERE assignment_id=?',
      Date.now(),
      assignmentId
    ).run()
    await deliver(
      g.id,
      grader,
      JSON.stringify({
        decision: 'restart',
        reason: 'Approved',
        checkpoint_verified: false,
        baseline_unchanged: true,
        termination_verified: true
      })
    )
    await tick(env(), g.id)
    const restarted = await rows<Assignment>(
      db,
      "SELECT * FROM graph_assignments WHERE parent_id=? AND role='execute'",
      assignmentId
    )
    expect(restarted).toHaveLength(1)
    expect(JSON.parse(restarted[0].input).user_input).toContain('First approval')
    expect(JSON.parse(restarted[0].input).user_input).toContain('Approval answer 3')
    // The restarted executor may encounter a different missing prerequisite.
    // Its next continuation must retain all earlier answers, not only the new one.
    await sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", restarted[0].id).run()
    await run(db, g.id, 'input', { assignment_id: restarted[0].id, message: 'Second execution answer' })
    const followup = (await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE parent_id=? AND role='continue'", restarted[0].id))[0]
    expect(JSON.parse(followup.input).prior_user_inputs.join('\n')).toContain('First approval')
    expect(JSON.parse(followup.input).prior_user_inputs.join('\n')).toContain('Approval answer 3')
    // Recover a legacy restart that already lost those answers from its own input.
    const legacy = await assignment(db, await graph(db, g.id), 'execute', { plan: {}, user_input: 'Later legacy answer' }, { parent: restarted[0].id })
    await db.batch([...legacy.statements, sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", legacy.id)])
    await run(db, g.id, 'input', { assignment_id: legacy.id, message: 'Newest answer' })
    const recovered = (await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE parent_id=? AND role='continue'", legacy.id))[0]
    expect(JSON.parse(recovered.input).prior_user_inputs.join('\n')).toContain('First approval')
    expect(JSON.parse(recovered.input).prior_user_inputs.join('\n')).toContain('Later legacy answer')
    const shortAnswer = await assignment(db, await graph(db, g.id), 'execute', { user_input: 'No' })
    const longerAnswer = await assignment(db, await graph(db, g.id), 'execute', { user_input: 'No additional changes' }, { parent: shortAnswer.id })
    await db.batch([...shortAnswer.statements, ...longerAnswer.statements, sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", longerAnswer.id)])
    await run(db, g.id, 'input', { assignment_id: longerAnswer.id, message: 'Check again' })
    const distinct = (await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE parent_id=? AND role='continue'", longerAnswer.id))[0]
    expect(JSON.parse(distinct.input).prior_user_inputs).toEqual(['No', 'No additional changes'])
  })

  it('denies cross-project graph reads and nonmember access', async () => {
    const own = await fixture(),
      other = await fixture()
    const auth = { uid: own.user, email: 'owner@test.com', userId: own.user, plan: 'pro' as const }
    const response = await graphRoute(
      new Request(`https://fixture.test/teams/${own.team}/graphs/${other.g.id}`),
      env() as unknown as Env,
      {} as ExecutionContext,
      auth
    )
    expect(response.status).toBe(404)
    const forbidden = await graphRoute(
      new Request(`https://fixture.test/teams/${other.team}/graphs`),
      env() as unknown as Env,
      {} as ExecutionContext,
      auth
    )
    expect(forbidden.status).toBe(403)
  })

  it('retains full Unicode text across bounded embedding chunks', () => {
    const text = '😀é observed state '.repeat(500)
    const chunks = embeddingChunks(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every((c) => new TextEncoder().encode(c).length <= 384)).toBe(true)
  })

  it('materializes immutable R2 snapshots without AI and retries index work later', async () => {
    const { g } = await fixture()
    const logs = await mf.getR2Bucket('LOGS')
    await materialize({ ...env(), LOGS: logs } as unknown as Env, g.id)
    expect(await logs.get(`graphs/${g.team_id}/${g.id}/snapshots/1.json`)).toBeTruthy()
    expect(
      (
        await rows<{ status: string }>(
          db,
          "SELECT status FROM graph_outbox WHERE graph_id=? AND kind='index'",
          g.id
        )
      )[0].status
    ).toBe('pending')
  })

  it('rejects cross-project and stale vectors while structured search works without embeddings', async () => {
    const { g } = await fixture()
    await resource(db, g.id, {
      title: 'Current source',
      description: '',
      body: 'Measured text',
      visibility: 'execution'
    })
    const current = await graph(db, g.id)
    const ref = (await rows<{ id: string }>(db, 'SELECT id FROM graph_resources WHERE graph_id=?', g.id))[0]
      .id
    const lexical = await search(env() as unknown as Env, current, 'Measured')
    expect(lexical.resources).toHaveLength(1)
    const indexed = {
      ...env(),
      GRAPH_AI: { run: async () => ({ data: [Array(768).fill(0)] }) },
      GRAPH_VECTORS: {
        query: async () => ({
          matches: [
            { metadata: { graph_id: 'other', version: current.version, entity_id: ref } },
            { metadata: { graph_id: g.id, version: current.version - 1, entity_id: ref } }
          ]
        })
      }
    } as unknown as Env
    expect((await search(indexed, current, 'semantic only')).resources).toHaveLength(0)
  })

  it('keeps continuation behind earlier grades even when a fallback agent is free', async () => {
    const { g, agent, grader, team } = await preparedExecution()
    const fallback = crypto.randomUUID()
    await sql(
      db,
      "INSERT INTO agents(id,team_id,name,status,created_at) VALUES(?,?,?,'idle',0)",
      fallback,
      team,
      fallback
    ).run()
    const c = await configuration(db, await graph(db, g.id))
    c.policy.fallback = fallback
    await sql(db, 'UPDATE graph_configs SET policy=? WHERE graph_id=?', JSON.stringify(c.policy), g.id).run()
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        outcome: 'complete',
        title: 'Needs access',
        description: '',
        body: 'Missing test access',
        evidence: [],
        actual_cost: 0
      })
    )
    await tick(env(), g.id)
    const blocked = await assignment(db, await graph(db, g.id), 'plan', {
      task: 'Separate blocked planning task'
    })
    await db.batch(blocked.statements)
    await sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", blocked.id).run()
    await run(db, g.id, 'input', {
      assignment_id: blocked.id,
      message: 'Access provided; verify before another attempt'
    })
    await tick(env(), g.id)
    const continuation = (
      await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='continue'", g.id)
    )[0]
    expect(continuation.status).toBe('pending')
    await deliver(g.id, grader, JSON.stringify({ local_score: null, evidence_ids: [], reason: 'Blocked' }))
    await tick(env(), g.id)
    await deliver(
      g.id,
      grader,
      JSON.stringify({ goal_score: null, evidence_ids: [], reason: 'No observation' })
    )
    await tick(env(), g.id)
    expect(
      (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', continuation.id))[0].status
    ).toBe('running')
    await deliver(
      g.id,
      grader,
      JSON.stringify({
        decision: 'blocked',
        reason: 'Still cannot verify baseline',
        checkpoint_verified: false,
        baseline_unchanged: false,
        termination_verified: false
      })
    )
    await tick(env(), g.id)
    expect(
      (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', continuation.id))[0].status
    ).toBe('blocked')
  })

  it('persists one read-only formatting repair without repeating execution', async () => {
    const { g, agent } = await fixture(false)
    await run(db, g.id, 'run')
    await tick(env(), g.id)
    await deliver(g.id, agent, 'not json')
    await processResults(db, await graph(db, g.id))
    const assignments = await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE graph_id=?', g.id)
    expect(assignments.filter((a) => a.role === 'repair')).toHaveLength(1)
    expect(assignments.filter((a) => a.role === 'execute')).toHaveLength(0)
  })

  it('treats a hand-closed invalid planning step as failed and queues a fresh copy', async () => {
    const { g, agent } = await fixture(false)
    await run(db, g.id, 'run')
    await tick(env(), g.id)
    await deliver(g.id, agent, '{"title":"Decompose goal into subgoals"}')
    await processResults(db, await graph(db, g.id))
    const [failed] = await rows<Assignment>(
      db,
      "SELECT * FROM graph_assignments WHERE graph_id=? AND role='decompose'",
      g.id
    )
    expect(failed.status).toBe('error')
    await run(db, g.id, 'fail', { assignment_id: failed.id })
    const all = await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE graph_id=?', g.id)
    expect(all.find((a) => a.id === failed.id)?.status).toBe('cancelled')
    expect(all.filter((a) => a.role === 'repair').every((a) => a.status === 'cancelled')).toBe(true)
    const fresh = all.filter((a) => a.role === 'decompose' && a.id !== failed.id)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toMatchObject({ status: 'pending', attempt_count: 0, input: failed.input })
    // A second close of the same, now cancelled, step is a no-op.
    await run(db, g.id, 'fail', { assignment_id: failed.id })
    expect(
      await rows(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='decompose'", g.id)
    ).toHaveLength(2)
  })
})

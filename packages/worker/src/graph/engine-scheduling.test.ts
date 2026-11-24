import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import {
  db,
  env,
  fixture,
  deliver,
  preparedExecution,
  setupGraphHarness,
  teardownGraphHarness,
} from './test-harness.js'
import { graph, configuration, sql, rows, commit, assignment, nodeStatements, type Assignment } from './store.js'
import { snapshot } from './snapshot.js'
import { clone } from './clone.js'
import { maintenance } from './maintenance.js'
import { dispatchContext } from './eligibility.js'
import { run, tick, dispatch, bindStatement } from './engine.js'


beforeAll(setupGraphHarness, 30000)
afterAll(teardownGraphHarness)

describe('graph scheduling and maintenance', () => {
  it('releases a stale execution queue entry without assignment noise and does not churn versions', async () => {
    const { g, agent, assignmentId } = await preparedExecution()
    const { attempt } = await deliver(
      g.id,
      agent,
      JSON.stringify({
        outcome: 'complete',
        title: 'Done',
        description: '',
        body: '',
        evidence: [],
        actual_cost: 0
      })
    )
    await db.batch([
      sql(db, "UPDATE graph_results SET status='stale' WHERE attempt_id=?", attempt.id),
      sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", assignmentId)
    ])
    await tick(env(), g.id)
    expect(
      await rows(db, "SELECT * FROM graph_serial_queue WHERE graph_id=? AND status='pending'", g.id)
    ).toHaveLength(0)
    const version = (await graph(db, g.id)).version
    await tick(env(), g.id)
    expect((await graph(db, g.id)).version).toBe(version)
  })

  it('passes active milestone IDs from periodic goal review to the decomposer for retirement', async () => {
    const { g, agent } = await fixture(false)
    const milestone = nodeStatements(db, g, 'milestone', { title: 'Obsolete', description: '', body: '' }, null)
    await db.batch([
      ...milestone.statements,
      sql(db, "UPDATE graphs SET status='running' WHERE id=?", g.id),
      sql(db, "UPDATE graph_maintenance SET next_at=0 WHERE graph_id=? AND kind='decomposition'", g.id)
    ])
    await maintenance(env(), g.id)
    await tick(env(), g.id)
    await deliver(g.id, agent, JSON.stringify({
      goal_score: null, evidence_ids: [], reason: 'Scope changed', decomposition_feedback: ['Retire obsolete work']
    }))
    await tick(env(), g.id)
    const step = await sql(db, "SELECT input FROM graph_assignments WHERE graph_id=? AND role='decompose'", g.id)
      .first<{ input: string }>()
    const hierarchy = JSON.parse(step!.input).existing_milestones
    expect(hierarchy).toMatchObject([{ id: milestone.id, title: 'Obsolete' }])
    await deliver(g.id, agent, JSON.stringify({ subgoals: [], retire_ids: [hierarchy[0].id] }))
    await tick(env(), g.id)
    const proposal = await sql(db, 'SELECT content FROM graph_proposals WHERE graph_id=?', g.id).first<{ content: string }>()
    expect(JSON.parse(proposal!.content)).toMatchObject({ kind: 'retire', node_id: milestone.id })
  })

  it('coalesces decomposition maintenance and skips unchanged reviewed contexts', async () => {
    const { g } = await fixture(false)
    await sql(db, "UPDATE graphs SET status='running' WHERE id=?", g.id).run()
    const wake = async () => {
      await sql(
        db,
        "UPDATE graph_maintenance SET next_at=0 WHERE graph_id=? AND kind='decomposition'",
        g.id
      ).run()
      await maintenance(env(), g.id)
    }
    await wake()
    await wake()
    const reviews = await rows<Assignment>(
      db,
      "SELECT * FROM graph_assignments WHERE graph_id=? AND role='project'",
      g.id
    )
    expect(reviews).toHaveLength(1)
    await sql(db, "UPDATE graph_assignments SET status='accepted' WHERE id=?", reviews[0].id).run()
    await wake()
    expect(
      await rows(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='project'", g.id)
    ).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      const next = await assignment(db, await graph(db, g.id), 'decompose', { goal: 'Revision', revision: i })
      await db.batch(next.statements)
    }
    await maintenance(env(), g.id)
    expect(
      await rows(
        db,
        "SELECT * FROM graph_assignments WHERE graph_id=? AND role='decompose' AND status='pending'",
        g.id
      )
    ).toHaveLength(1)
  })

  it('does not expire queued work while a blocked step starves the queue', async () => {
    const { g } = await fixture(false)
    await sql(db, "UPDATE graphs SET status='running' WHERE id=?", g.id).run()
    const queued = await assignment(db, g, 'execute', { task: 'Queued' })
    const blocked = await assignment(db, g, 'continue', { task: 'Blocked' })
    await db.batch([...queued.statements, ...blocked.statements])
    await sql(db, "UPDATE graph_assignments SET available_at=0 WHERE id=?", queued.id).run()
    const cleanup = async () => {
      await sql(db, "UPDATE graph_maintenance SET next_at=0 WHERE graph_id=? AND kind='cleanup'", g.id).run()
      await maintenance(env(), g.id)
    }
    const status = async () =>
      (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', queued.id))[0].status
    await sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", blocked.id).run()
    await cleanup()
    expect(await status()).toBe('pending')
    await sql(db, "UPDATE graph_assignments SET status='accepted' WHERE id=?", blocked.id).run()
    await cleanup()
    expect(await status()).toBe('expired')
  })

  it('does not let a closed graph\'s finished attempt hold an agent other graphs need', async () => {
    const { g } = await fixture(false)
    const other = await fixture(false)
    const ex = await assignment(db, other.g, 'execute', { task: 'Held' })
    await db.batch(ex.statements)
    const task = crypto.randomUUID(),
      attempt = crypto.randomUUID()
    await db.batch([
      sql(db, "INSERT INTO tasks(id,team_id,agent_id,sender_id,subject,status,created_at) VALUES(?,?,?,?,'x','failed',0)", task, other.g.team_id, other.agent, other.user),
      sql(db, "INSERT INTO graph_attempts(id,assignment_id,task_id,agent_id,status,epoch,deadline,created_at) VALUES(?,?,?,?,'timeout',1,0,0)", attempt, ex.id, task, other.agent)
    ])
    await db.batch([
      sql(db, "INSERT INTO graph_reservations(agent_id,attempt_id,graph_id,kind,created_at) VALUES(?,?,?,'execution',0)", other.agent, attempt, other.g.id),
      sql(db, "UPDATE graphs SET status='stopped' WHERE id=?", other.g.id)
    ])
    const held = async () => (await dispatchContext(db, await graph(db, g.id))).used.filter((r) => r.agent_id === other.agent).length
    expect(await held()).toBe(0)
    await sql(db, "UPDATE graph_attempts SET status='running' WHERE id=?", attempt).run()
    expect(await held()).toBe(1)
    await sql(db, "UPDATE graph_attempts SET status='timeout' WHERE id=?", attempt).run()
    await dispatch(env(), await graph(db, g.id))
    expect(await rows(db, 'SELECT * FROM graph_reservations WHERE attempt_id=?', attempt)).toHaveLength(0)
  })

  it('reopens a dismissed queue entry needed by a checked continuation', async () => {
    const { g } = await fixture(false)
    const original = await assignment(db, g, 'project', { operation: 'decomposition_review', hierarchy: [], evidence: [] })
    await db.batch([
      ...original.statements,
      sql(db, "INSERT INTO graph_serial_queue(graph_id,kind,work_id,status,created_at) VALUES(?,'assignment',?,'done',?)", g.id, original.id, Date.now())
    ])
    await sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=?", original.id).run()
    await run(db, g.id, 'input', { assignment_id: original.id, message: 'Retry the read-only review' })
    await tick(env(), g.id)
    const followup = (await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE parent_id=? AND role='continue'", original.id))[0]
    expect(followup.status).toBe('running')
    expect(await rows(db, "SELECT * FROM graph_serial_queue WHERE graph_id=? AND status='pending'", g.id)).toHaveLength(1)
  })

  it('reports the live scheduler heap without persisting or dispatching preview weights', async () => {
    const { g, assignmentId } = await preparedExecution()
    const original = (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', assignmentId))[0]
    const candidates = []
    for (let i = 0; i < 3; i++) {
      const next = await assignment(db, await graph(db, g.id), 'execute', JSON.parse(original.input), { node: original.node_id, edge: original.edge_id })
      await db.batch(next.statements)
      candidates.push(next.id)
    }
    await sql(db, 'UPDATE graph_assignments SET priority=0.99 WHERE id=?', candidates[0]).run()
    await sql(db, 'UPDATE graph_assignments SET available_at=? WHERE id=?', Date.now() + 60000, candidates[2]).run()
    const before = (await graph(db, g.id)).version
    const preview = (await snapshot(db, await graph(db, g.id))).scheduler as {
      heap: string[]; candidates: { assignment_id: string; weight: number }[]; next_selection: string
    }
    expect(preview.heap).toEqual(candidates.slice(0, 2).sort())
    expect(preview.candidates).toHaveLength(3)
    expect(preview.candidates.every((c) => c.weight === 0.5)).toBe(true)
    expect((await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', candidates[0]))[0].priority).toBe(0.99)
    expect((await graph(db, g.id)).version).toBe(before)
    await sql(db, 'UPDATE graph_budgets SET allocations=4 WHERE graph_id=?', g.id).run()
    expect(((await snapshot(db, await graph(db, g.id))).scheduler as { next_selection: string }).next_selection).toBe('lowest')
  })

  it('uses dispatch eligibility for paused, budget, agent, capability and termination explanations', async () => {
    const { g, agent, assignmentId } = await preparedExecution()
    // Put the unstarted dispatch back in the queue without allowing it to execute.
    await db.batch([
      sql(db, "UPDATE graph_attempts SET status='cancelled' WHERE assignment_id=?", assignmentId),
      sql(
        db,
        "UPDATE tasks SET status='cancelled' WHERE id IN (SELECT task_id FROM graph_attempts WHERE assignment_id=?)",
        assignmentId
      ),
      sql(db, 'DELETE FROM graph_reservations WHERE graph_id=?', g.id),
      sql(db, "UPDATE graph_assignments SET status='pending' WHERE id=?", assignmentId)
    ])
    const reason = async () =>
      ((await snapshot(db, await graph(db, g.id))).waiting as Record<string, { code: string }>)[assignmentId]
        .code
    await run(db, g.id, 'pause')
    expect(await reason()).toBe('paused')
    await sql(db, "UPDATE graphs SET status='running' WHERE id=?", g.id).run()
    const c = await configuration(db, await graph(db, g.id))
    await sql(
      db,
      'UPDATE graph_budgets SET execution_cost=? WHERE graph_id=?',
      c.policy.cost_budget,
      g.id
    ).run()
    expect(await reason()).toBe('cost_budget')
    await sql(db, 'UPDATE graph_budgets SET execution_cost=0 WHERE graph_id=?', g.id).run()
    await sql(db, 'DELETE FROM graph_agent_capabilities WHERE agent_id=?', agent).run()
    expect(await reason()).toBe('capability')
    await sql(db, "UPDATE agents SET status='offline' WHERE id=?", agent).run()
    expect(await reason()).toBe('agent')
    const attempt = (
      await rows<{ task_id: string }>(
        db,
        'SELECT task_id FROM graph_attempts WHERE assignment_id=?',
        assignmentId
      )
    )[0]
    const session = crypto.randomUUID()
    await sql(
      db,
      "INSERT INTO sessions(id,task_id,agent_id,status,started_at) VALUES(?,?,?,'running',0)",
      session,
      attempt.task_id,
      agent
    ).run()
    await sql(db, 'UPDATE graph_attempts SET session_id=? WHERE assignment_id=?', session, assignmentId).run()
    expect(await reason()).toBe('termination')
  })

  it('cancels a dispatched but unopened execution on Stop, and Run creates a fresh attempt', async () => {
    const { g, agent, assignmentId } = await preparedExecution()
    const old = (
      await rows<{ task_id: string; id: string }>(
        db,
        'SELECT * FROM graph_attempts WHERE assignment_id=?',
        assignmentId
      )
    )[0]
    await run(db, g.id, 'stop')
    expect(
      (await rows<{ status: string }>(db, 'SELECT status FROM tasks WHERE id=?', old.task_id))[0].status
    ).toBe('cancelled')
    expect(await rows(db, 'SELECT * FROM graph_reservations WHERE attempt_id=?', old.id)).toHaveLength(0)
    await expect(bindStatement(db, old.task_id, agent, crypto.randomUUID())).rejects.toThrow('Unexpected')
    // Closing is permanent: nothing can resume or change the graph.
    await expect(run(db, g.id, 'run')).rejects.toThrow('closed')
    await expect(run(db, g.id, 'dismiss')).rejects.toThrow('closed')
    await run(db, g.id, 'stop')
    expect((await graph(db, g.id)).status).toBe('stopped')
    const nodeCount = async (id: string) =>
      (await rows<{ n: number }>(db, 'SELECT COUNT(*) n FROM graph_nodes WHERE graph_id=?', id))[0].n
    const edgeCount = async (id: string) =>
      (await rows<{ n: number }>(db, 'SELECT COUNT(*) n FROM graph_edges WHERE graph_id=?', id))[0].n
    const src = await graph(db, g.id)
    const fresh = await clone(db, src.team_id, src.owner_id, g.id, false)
    expect(fresh.status).toBe('draft')
    expect(fresh.body).toBe(src.body)
    expect(await nodeCount(fresh.id)).toBe(2)
    expect(await edgeCount(fresh.id)).toBe(0)
    const full = await clone(db, src.team_id, src.owner_id, g.id, true)
    expect(await nodeCount(full.id)).toBe(await nodeCount(g.id))
    expect(await edgeCount(full.id)).toBe(await edgeCount(g.id))
    await run(db, full.id, 'run')
    await expect(clone(db, src.team_id, src.owner_id, full.id, false)).rejects.toThrow('closed')
  })

  it('enforces execution capacity independently of available agent count', async () => {
    const { g, team, assignmentId } = await preparedExecution()
    const c = await configuration(db, await graph(db, g.id)),
      source = (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', assignmentId))[0]
    for (let i = 0; i < 2; i++) {
      const agent = crypto.randomUUID()
      c.policy.agents.push(agent)
      await db.batch([
        sql(
          db,
          "INSERT INTO agents(id,team_id,name,status,created_at) VALUES(?,?,?,'idle',0)",
          agent,
          team,
          agent
        ),
        sql(
          db,
          'INSERT INTO graph_agent_capabilities(agent_id,version,seen_at) VALUES(?,1,?)',
          agent,
          Date.now()
        )
      ])
      const current = await graph(db, g.id),
        next = await assignment(db, current, 'execute', JSON.parse(source.input), {
          node: source.node_id,
          edge: source.edge_id
        })
      await commit(db, current, 'seed_independent_trial', next.id, {}, next.statements)
    }
    c.policy.capacity = 2
    await sql(db, 'UPDATE graph_configs SET policy=? WHERE graph_id=?', JSON.stringify(c.policy), g.id).run()
    await tick(env(), g.id)
    expect(
      await rows(db, "SELECT * FROM graph_reservations WHERE graph_id=? AND kind='execution'", g.id)
    ).toHaveLength(2)
    c.policy.capacity = 3
    await sql(db, 'UPDATE graph_configs SET policy=? WHERE graph_id=?', JSON.stringify(c.policy), g.id).run()
    await tick(env(), g.id)
    expect(
      await rows(db, "SELECT * FROM graph_reservations WHERE graph_id=? AND kind='execution'", g.id)
    ).toHaveLength(3)
  })

  it('creates the missing execute assignment for an edge published while paused when the graph resumes', async () => {
    const f = await fixture(false, true)
    const g = await graph(db, f.g.id)
    const source = (
      await rows<{ id: string }>(db, "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='observed'", g.id)
    )[0].id
    const ref = (await rows<{ id: string }>(db, 'SELECT id FROM graph_resources WHERE graph_id=?', g.id))[0]
      .id
    const target = nodeStatements(
      db,
      g,
      'outcome',
      { title: 'Late target', description: '', body: 'x' },
      null
    )
    const edge = crypto.randomUUID()
    await commit(db, g, 'seed_paused_edge', null, {}, [
      ...target.statements,
      sql(
        db,
        'INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        edge,
        g.id,
        source,
        target.id,
        'Late action',
        '',
        '',
        'fixture',
        Date.now()
      ),
      sql(
        db,
        'INSERT INTO graph_plans(edge_id,baseline,predicates,steps,undo_steps,cost,recovery_cost,resource_versions,effects) VALUES(?,?,?,?,?,?,?,?,?)',
        edge,
        'base',
        JSON.stringify(['restored']),
        JSON.stringify(['do']),
        JSON.stringify(['undo']),
        1,
        1,
        JSON.stringify([ref]),
        JSON.stringify(['effect'])
      )
    ])
    expect(
      await rows(db, "SELECT id FROM graph_assignments WHERE edge_id=? AND role='execute'", edge)
    ).toHaveLength(0)
    await run(db, g.id, 'run')
    const created = await rows<{ status: string }>(
      db,
      "SELECT status FROM graph_assignments WHERE edge_id=? AND role='execute'",
      edge
    )
    expect(created).toHaveLength(1)
    expect(created[0].status).toBe('pending')
    // Resuming again must not duplicate the assignment.
    await run(db, g.id, 'pause')
    await run(db, g.id, 'run')
    expect(
      await rows(db, "SELECT id FROM graph_assignments WHERE edge_id=? AND role='execute'", edge)
    ).toHaveLength(1)
  })
})

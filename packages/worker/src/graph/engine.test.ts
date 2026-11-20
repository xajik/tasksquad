import { create as inboxReply } from '../routes/messages.js'
import { graphInboxTask } from './inbox.js'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { Miniflare } from 'miniflare'
import { buildSync } from 'esbuild'
import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import {
  create,
  graph,
  configuration,
  sql,
  rows,
  snapshot,
  resource,
  commit,
  assignment,
  nodeStatements,
  type Assignment,
  type Result
} from './store.js'
import { materialize, embeddingChunks } from './outbox.js'
import { search } from './search.js'
import { clone } from './store.js'
import { maintenance } from './maintenance.js'
import { run, tick, intake, bindStatement, processResults, advanceGrading } from './engine.js'
import { handle as graphRoute } from '../routes/graphs.js'
import { sessionOpen, sessionNotify, sessionClose } from '../routes/daemon.js'
import type { Env } from '../types.js'
import type { GraphEnv } from './engine.js'

let mf: Miniflare, db: D1Database
let runtimeOptions: ConstructorParameters<typeof Miniflare>[0]
const env = () =>
  ({ DB: db, ACTION_GRAPH_ENABLED: 'true', POLL_CACHE: { put: async () => undefined } }) as GraphEnv
async function fixture(review = true, execution = false) {
  const team = crypto.randomUUID(),
    user = crypto.randomUUID(),
    agent = crypto.randomUUID()
  await db.batch([
    sql(
      db,
      'INSERT INTO users(id,firebase_uid,email,created_at) VALUES(?,?,?,0)',
      user,
      user,
      user + '@test.com'
    ),
    sql(db, 'INSERT INTO teams(id,name,owner_id,created_at) VALUES(?,?,?,0)', team, 'Project', user),
    sql(db, "INSERT INTO team_members(team_id,user_id,role,joined_at) VALUES(?,?,'owner',0)", team, user),
    sql(
      db,
      "INSERT INTO agents(id,team_id,name,status,created_at) VALUES(?,?,?,'idle',0)",
      agent,
      team,
      agent
    )
  ])
  const grader = execution ? crypto.randomUUID() : agent
  if (execution)
    await sql(
      db,
      "INSERT INTO agents(id,team_id,name,status,created_at) VALUES(?,?,?,'idle',0)",
      grader,
      team,
      grader
    ).run()
  const g = await create(db, team, user, {
    title: 'Goal',
    description: '',
    body: 'Private target',
    start_state: 'Baseline',
    rule: { op: 'AND', predicates: ['verified'], scope: 'test' },
    policy: { agents: [agent], grader, decomposer: agent, review }
  })
  return { g, user, agent, team, grader }
}
async function deliver(graphId: string, agent: string, raw: string, beforeIntake?: () => Promise<void>) {
  const attempt = await sql(
    db,
    `SELECT t.* FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? AND t.agent_id=? ORDER BY t.created_at DESC,t.id DESC LIMIT 1`,
    graphId,
    agent
  ).first<{ id: string; task_id: string }>()
  expect(attempt).toBeTruthy()
  const session = crypto.randomUUID()
  const bind = await bindStatement(db, attempt!.task_id, agent, session)
  await db.batch([
    sql(
      db,
      "INSERT INTO sessions(id,task_id,agent_id,status,started_at) VALUES(?,?,?,'running',0)",
      session,
      attempt!.task_id,
      agent
    ),
    ...bind
  ])
  if (beforeIntake) await beforeIntake()
  await intake(env(), session, agent, raw)
  return { session, attempt: attempt! }
}

async function preparedExecution() {
  const f = await fixture(false, true)
  await resource(db, f.g.id, { title: 'Source', description: '', body: 'Baseline', visibility: 'execution' })
  const g = await graph(db, f.g.id)
  const source = (
    await rows<{ id: string }>(db, "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='observed'", g.id)
  )[0].id
  const ref = (await rows<{ id: string }>(db, 'SELECT id FROM graph_resources WHERE graph_id=?', g.id))[0].id
  const target = nodeStatements(
    db,
    g,
    'outcome',
    { title: 'Target', description: '', body: 'Candidate' },
    null
  )
  const edge = crypto.randomUUID()
  const plan = {
    title: 'Action',
    description: '',
    body: 'Bounded change',
    from_id: source,
    expected_quality: 0.7,
    baseline: 'cfg-v1',
    restoration_predicates: ['restored'],
    steps: ['Bounded change'],
    undo_steps: ['Restore cfg-v1'],
    cost: 1,
    recovery_cost: 1,
    resource_versions: [ref],
    effects: ['scoped change']
  }
  const a = await assignment(db, g, 'execute', { plan, target_node: target.id }, { node: target.id, edge })
  await commit(db, g, 'seed_reviewed_plan', null, {}, [
    ...target.statements,
    sql(
      db,
      'INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      edge,
      g.id,
      source,
      target.id,
      'Action',
      '',
      '',
      'fixture',
      Date.now()
    ),
    ...a.statements
  ])
  await sql(
    db,
    'INSERT INTO graph_agent_capabilities(agent_id,version,seen_at) VALUES(?,1,?)',
    f.agent,
    Date.now()
  ).run()
  await run(db, g.id, 'run')
  await tick(env(), g.id)
  return { ...f, ref, assignmentId: a.id }
}

beforeAll(async () => {
  const runtime = buildSync({
    stdin: {
      contents: `
   import {GraphCoordinator as Base} from './src/graph/coordinator.ts';
   export class GraphCoordinator extends Base {async alarmForTest(){await this.alarm()}}
   export default {async fetch(request,env){const data=await request.json();try{
    const stub=env.GRAPH_COORDINATOR.get(env.GRAPH_COORDINATOR.idFromName(data.team));
    if(data.command==='alarm')await stub.alarmForTest();
    else await stub.command(data.graph,data.command,{team_id:data.team,...data.body});
    return Response.json({ok:true});
   }catch(error){return Response.json({error:String(error)},{status:400})}}}
  `,
      resolveDir: process.cwd()
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    external: ['cloudflare:workers'],
    write: false
  }).outputFiles[0].text
  runtimeOptions = {
    modules: true,
    script: runtime,
    durableObjects: { GRAPH_COORDINATOR: { className: 'GraphCoordinator', useSQLite: true } },
    kvNamespaces: ['POLL_CACHE'],
    r2Buckets: ['LOGS'],
    bindings: { ACTION_GRAPH_ENABLED: 'true' },
    d1Databases: ['DB'],
    compatibilityDate: '2026-01-01'
  }
  mf = new Miniflare(runtimeOptions)
  db = await mf.getD1Database('DB')
  for (const filename of readdirSync('migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const statements = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `
import sqlite3,json,sys
source=open(sys.argv[1]).read(); pending=''; statements=[]
for char in source:
 pending+=char
 if char==';' and sqlite3.complete_statement(pending):
  statements.append(pending); pending=''
print(json.dumps(statements))
`,
          `migrations/${filename}`
        ],
        { encoding: 'utf8' }
      )
    ) as string[]
    for (const statement of statements) await db.prepare(statement).run()
  }
}, 30000)
afterAll(async () => {
  await mf?.dispose()
})

describe('durable inbox graph workflow', () => {
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
    // The daemon closes the inbox task as done; a step waiting for the owner must go back to pending input.
    await sql(db, "UPDATE tasks SET status='done' WHERE id=?", attempt.task_id).run()
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
    const { g, agent, grader, team, assignmentId } = await preparedExecution()
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
        outcome: 'blocked',
        title: 'Needs access',
        description: '',
        body: 'Missing test access',
        evidence: [],
        actual_cost: 0
      })
    )
    await tick(env(), g.id)
    await run(db, g.id, 'input', {
      assignment_id: assignmentId,
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
      (await rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE id=?', assignmentId))[0].status
    ).toBe('blocked')
  })

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
    await mf.setOptions({
      ...runtimeOptions,
      script: String(runtimeOptions.script) + '\n// restart coordinator isolate'
    })
    db = await mf.getD1Database('DB')
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

  it('creates the missing execute assignment for an edge published while paused when the graph resumes', async () => {
    const f = await fixture(false, true)
    const g = await graph(db, f.g.id)
    const source = (
      await rows<{ id: string }>(db, "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='observed'", g.id)
    )[0].id
    const ref = (await rows<{ id: string }>(db, 'SELECT id FROM graph_resources WHERE graph_id=?', g.id))[0].id
    const target = nodeStatements(db, g, 'outcome', { title: 'Late target', description: '', body: 'x' }, null)
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

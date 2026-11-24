// Shared Miniflare harness for graph tests: real coordinator DO, D1 with all migrations applied.
import { expect } from 'vitest'
import { Miniflare } from 'miniflare'
import { buildSync } from 'esbuild'
import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { create, graph, sql, rows, resource, commit, assignment, nodeStatements } from './store.js'
import { run, tick, intake, bindStatement } from './engine.js'
import type { GraphEnv } from './engine.js'

export let mf: Miniflare, db: D1Database
export let runtimeOptions: ConstructorParameters<typeof Miniflare>[0]
export const env = () =>
  ({ DB: db, ACTION_GRAPH_ENABLED: 'true', POLL_CACHE: { put: async () => undefined } }) as GraphEnv
export async function fixture(review = true, execution = false) {
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
export async function deliver(graphId: string, agent: string, raw: string, beforeIntake?: () => Promise<void>) {
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

export async function preparedExecution() {
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

export async function setupGraphHarness() {
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
}
export async function teardownGraphHarness() {
  await mf?.dispose()
}
export async function restartGraphHarness(suffix: string) {
  await mf.setOptions({ ...runtimeOptions, script: String(runtimeOptions.script) + suffix })
  db = await mf.getD1Database('DB')
}

import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { db, env, fixture, deliver, setupGraphHarness, teardownGraphHarness } from './test-harness.js'
import { graph, sql, rows, commit, assignment, type Assignment } from './store.js'
import { resource } from './mutations.js'
import { run, tick } from './engine.js'

beforeAll(setupGraphHarness, 30000)
afterAll(teardownGraphHarness)

const action = (from: string, ref: string, over: Record<string, unknown> = {}) => ({
  title: 'Add retry to uploader',
  expected_quality: 0.7,
  description: '',
  body: 'Make the uploader retry failed chunks',
  from_id: from,
  baseline: 'cfg-v1',
  restoration_predicates: ['restored'],
  steps: ['Edit uploader.ts to retry failed chunks', 'Run the uploader tests'],
  undo_steps: ['git revert'],
  cost: 1,
  recovery_cost: 1,
  resource_versions: [ref],
  effects: ['Uploader retries failed chunks'],
  ...over
})

async function seeded() {
  const { g, agent } = await fixture(false)
  await resource(db, g.id, { title: 'Source', description: '', body: 'Baseline', visibility: 'execution' })
  const source = (await rows<{ id: string }>(db, "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='observed'", g.id))[0].id
  const ref = (await rows<{ id: string }>(db, 'SELECT id FROM graph_resources WHERE graph_id=?', g.id))[0].id
  await sql(db, 'INSERT INTO graph_agent_capabilities(agent_id,version,seen_at) VALUES(?,1,?)', agent, Date.now()).run()
  await run(db, g.id, 'run')
  // This test drives planning directly; skip the decomposition run() queued.
  await sql(db, "UPDATE graph_assignments SET status='cancelled' WHERE graph_id=? AND role='decompose'", g.id).run()
  const gr = await graph(db, g.id)
  const a = await assignment(db, gr, 'plan', { task: 'plan', observations: [], resources: [], attempted_actions: { actions: [], proposals: [] } })
  await commit(db, gr, 'seed_plan', null, {}, a.statements)
  await tick(env(), g.id)
  return { g, agent, source, ref }
}
const mergeInputs = (id: string) =>
  rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='merge' ORDER BY created_at,id", id)

describe('graph action dedup', () => {
  it('gives merge review the attempted-action ledger, lets it name a duplicate and drops reworded repeats before review', async () => {
    const { g, agent, source, ref } = await seeded()
    await deliver(g.id, agent, JSON.stringify({ actions: [action(source, ref)] }))
    await tick(env(), g.id)
    const [first] = await mergeInputs(g.id)
    const input = JSON.parse(first.input)
    expect(input.existing_actions).toEqual({ actions: [], proposals: expect.any(Array) })
    expect(input.near_duplicates).toEqual([])
    await deliver(g.id, agent, JSON.stringify({ decision: 'distinct', equivalent_node_id: null, reason: 'new' }))
    await tick(env(), g.id)
    const edges = await rows<{ id: string }>(db, 'SELECT id FROM graph_edges WHERE graph_id=?', g.id)
    expect(edges).toHaveLength(1)
    const stored = await sql(db, 'SELECT fingerprint FROM graph_plans WHERE edge_id=?', edges[0].id).first<{ fingerprint: string }>()
    expect(stored?.fingerprint).toMatch(/^[0-9a-f]{16,}$/)

    // A later planner rewords the same action: dropped without another merge review.
    const gr = await graph(db, g.id)
    const again = await assignment(db, gr, 'plan', { task: 'plan again', observations: [], resources: [] })
    await commit(db, gr, 'seed_plan_2', null, {}, again.statements)
    await sql(db, "UPDATE graph_assignments SET status='cancelled' WHERE graph_id=? AND role='execute'", g.id).run()
    await sql(db, 'DELETE FROM graph_reservations WHERE graph_id=?', g.id).run()
    await tick(env(), g.id)
    const before = (await mergeInputs(g.id)).length
    await deliver(
      g.id,
      agent,
      JSON.stringify({
        actions: [
          action(source, ref, {
            title: 'Uploader: retry failed chunks',
            body: 'Retries for the uploader',
            effects: ['Failed chunks are retried by the uploader'],
            steps: ['Edit uploader.ts so failed chunks retry', 'Run uploader tests']
          })
        ]
      })
    )
    await tick(env(), g.id)
    expect((await mergeInputs(g.id)).length).toBe(before)
    const rejected = await rows<{ content: string }>(db, "SELECT content FROM graph_proposals WHERE graph_id=? AND status='rejected'", g.id)
    expect(rejected).toHaveLength(1)
    expect(JSON.parse(rejected[0].content).duplicate_of).toBe(edges[0].id)
    expect(await rows(db, 'SELECT id FROM graph_edges WHERE graph_id=?', g.id)).toHaveLength(1)
  })

  it('publishes nothing when the reviewer names an existing action as the duplicate', async () => {
    const { g, agent, source, ref } = await seeded()
    // Seed a legacy edge (no fingerprint) that differs enough in text to need the reviewer.
    const gr = await graph(db, g.id)
    const target = crypto.randomUUID(),
      edge = crypto.randomUUID()
    await commit(db, gr, 'seed_edge', null, {}, [
      sql(db, "INSERT INTO graph_nodes(id,graph_id,kind,title,description,body,created_at) VALUES(?,?,'outcome','T','','b',0)", target, g.id),
      sql(db, "INSERT INTO graph_node_states(graph_id,node_id,state,created_at) VALUES(?,?,'active',0)", g.id, target),
      sql(db, "INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at) VALUES(?,?,?,?,'Logging','','','x',0)", edge, g.id, source, target),
      sql(db, "INSERT INTO graph_plans(edge_id,baseline,predicates,steps,undo_steps,cost,recovery_cost,resource_versions,effects) VALUES(?,?,?,?,?,1,1,?,?)", edge, 'b', '[]', '["add log lines"]', '["revert"]', JSON.stringify([ref]), '["more logging"]')
    ])
    await deliver(g.id, agent, JSON.stringify({ actions: [action(source, ref, { title: 'Instrument', effects: ['observability'], steps: ['wire tracing spans'] })] }))
    await tick(env(), g.id)
    const [merge] = await mergeInputs(g.id)
    expect(JSON.parse(merge.input).existing_actions.actions.map((a: { edge_id: string }) => a.edge_id)).toContain(edge)
    await deliver(g.id, agent, JSON.stringify({ decision: 'duplicate_action', equivalent_node_id: null, duplicate_edge_id: edge, reason: 'same intent' }))
    await tick(env(), g.id)
    expect(await rows(db, 'SELECT id FROM graph_edges WHERE graph_id=?', g.id)).toHaveLength(1)
    expect((await rows<{ status: string }>(db, 'SELECT status FROM graph_proposals WHERE graph_id=?', g.id))[0].status).toBe('published')
  })
})

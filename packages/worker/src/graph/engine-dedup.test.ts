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

  it('folds legacy reworded duplicates on resume: keeps one action, cancels the unstarted rest, leaves history alone', async () => {
    const { g, source, ref } = await seeded()
    await sql(db, "UPDATE graph_assignments SET status='cancelled' WHERE graph_id=?", g.id).run()
    const gr = await graph(db, g.id)
    const seed = async (title: string, effects: string[], steps: string[], started: boolean) => {
      const target = crypto.randomUUID(),
        edge = crypto.randomUUID()
      const a = await assignment(db, gr, 'execute', { plan: { title }, target_node: target }, { node: target, edge })
      await commit(db, gr, 'seed_legacy', null, {}, [
        sql(db, "INSERT INTO graph_nodes(id,graph_id,kind,title,description,body,created_at) VALUES(?,?,'outcome',?,'','b',0)", target, g.id, title),
        sql(db, "INSERT INTO graph_node_states(graph_id,node_id,state,created_at) VALUES(?,?,'active',0)", g.id, target),
        sql(db, "INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at) VALUES(?,?,?,?,?,'','','x',?)", edge, g.id, source, target, title, Date.now()),
        sql(db, "INSERT INTO graph_plans(edge_id,baseline,predicates,steps,undo_steps,cost,recovery_cost,resource_versions,effects) VALUES(?,?,?,?,?,1,1,?,?)", edge, 'b', '[]', JSON.stringify(steps), '[]', JSON.stringify([ref]), JSON.stringify(effects)),
        ...a.statements
      ])
      if (started) await sql(db, "UPDATE graph_assignments SET attempt_count=1,status='accepted' WHERE id=?", a.id).run()
      return { edge, target, assignment: a.id }
    }
    const kept = await seed('Add retry to uploader', ['Uploader retries failed chunks'], ['Edit uploader.ts to retry failed chunks', 'Run the uploader tests'], true)
    const dup = await seed('Uploader: retry failed chunks', ['Failed chunks are retried by the uploader'], ['Edit uploader.ts so failed chunks retry', 'Run uploader tests'], false)
    const other = await seed('Rotate signing keys', ['New key published'], ['Run rotate script'], false)
    await run(db, g.id, 'dedup')
    const status = async (id: string) => (await sql(db, 'SELECT status,cancel_reason FROM graph_assignments WHERE id=?', id).first<{ status: string; cancel_reason: string | null }>())!
    expect((await status(kept.assignment)).status).toBe('accepted')
    expect(await status(dup.assignment)).toEqual({ status: 'cancelled', cancel_reason: 'duplicate' })
    expect((await status(other.assignment)).status).toBe('pending')
    const state = async (n: string) => (await sql(db, 'SELECT state FROM graph_node_states WHERE node_id=? ORDER BY id DESC LIMIT 1', n).first<{ state: string }>())!.state
    expect(await state(dup.target)).toBe('deactivated')
    expect(await state(kept.target)).toBe('active')
    const fps = await rows<{ edge_id: string; fingerprint: string | null }>(db, 'SELECT edge_id,fingerprint FROM graph_plans')
    expect(fps.find((f) => f.edge_id === kept.edge)?.fingerprint).toBeTruthy()
    expect(fps.find((f) => f.edge_id === dup.edge)?.fingerprint).toBeNull()
    await run(db, g.id, 'dedup') // idempotent
    expect((await status(other.assignment)).status).toBe('pending')
  })

  describe('vector recall', () => {
    const withVectors = (matches: { id: string; score: number }[], onQuery?: (arg: unknown) => void) =>
      ({
        ...env(),
        GRAPH_AI: { run: async () => ({ data: [Array(768).fill(0.1)] }) },
        GRAPH_VECTORS: {
          query: async (_v: number[], options: unknown) => {
            onQuery?.(options)
            return { matches: matches.map((m) => ({ score: m.score, metadata: { graph_id: gid, entity_id: m.id } })) }
          }
        }
      }) as unknown as ReturnType<typeof env>
    let gid = ''
    // A legacy edge whose words share nothing with the candidate, so only embeddings can connect them.
    const legacy = async (g: { id: string }, source: string, ref: string) => {
      const gr = await graph(db, g.id)
      const target = crypto.randomUUID(),
        edge = crypto.randomUUID()
      await commit(db, gr, 'seed_edge', null, {}, [
        sql(db, "INSERT INTO graph_nodes(id,graph_id,kind,title,description,body,created_at) VALUES(?,?,'outcome','T','','b',0)", target, g.id),
        sql(db, "INSERT INTO graph_node_states(graph_id,node_id,state,created_at) VALUES(?,?,'active',0)", g.id, target),
        sql(db, "INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at) VALUES(?,?,?,?,'Harden transfers','','','x',0)", edge, g.id, source, target),
        sql(db, "INSERT INTO graph_plans(edge_id,baseline,predicates,steps,undo_steps,cost,recovery_cost,resource_versions,effects) VALUES(?,?,?,?,?,1,1,?,?)", edge, 'b', '[]', '["wrap sockets"]', '["revert"]', JSON.stringify([ref]), '["resilient uploads"]')
      ])
      return edge
    }

    it('drops an action that is semantically identical to a same-source, same-resource action, scoped to the graph', async () => {
      const { g, agent, source, ref } = await seeded()
      gid = g.id
      const edge = await legacy(g, source, ref)
      let filter: unknown
      await deliver(g.id, agent, JSON.stringify({ actions: [action(source, ref)] }))
      await tick(withVectors([{ id: edge, score: 0.96 }], (o) => (filter = o)), g.id)
      expect(filter).toMatchObject({ namespace: g.team_id, filter: { graph_id: g.id } })
      expect(await mergeInputs(g.id)).toHaveLength(0)
      const rejected = await rows<{ content: string }>(db, "SELECT content FROM graph_proposals WHERE graph_id=? AND status='rejected'", g.id)
      expect(JSON.parse(rejected[0].content).duplicate_of).toBe(edge)
    })

    it('hands a middling semantic match to the reviewer with its score, and ignores hits for other sources', async () => {
      const { g, agent, source, ref } = await seeded()
      gid = g.id
      const edge = await legacy(g, source, ref)
      await deliver(g.id, agent, JSON.stringify({ actions: [action(source, ref)] }))
      await tick(withVectors([{ id: edge, score: 0.85 }, { id: 'not-in-this-graph', score: 0.99 }]), g.id)
      const [merge] = await mergeInputs(g.id)
      const near = JSON.parse(merge.input).near_duplicates
      expect(near).toHaveLength(1)
      expect(near[0]).toMatchObject({ edge_id: edge, semantic: 0.85, duplicate: false })
    })

    it('falls back to token similarity when the vector index fails', async () => {
      const { g, agent, source, ref } = await seeded()
      gid = g.id
      await deliver(g.id, agent, JSON.stringify({ actions: [action(source, ref)] }))
      const broken = { ...env(), GRAPH_AI: { run: async () => { throw new Error('ai down') } }, GRAPH_VECTORS: { query: async () => ({ matches: [] }) } } as unknown as ReturnType<typeof env>
      await tick(broken, g.id)
      expect(await mergeInputs(g.id)).toHaveLength(1)
    })
  })
})

describe('milestone equivalent to the root goal', () => {
  it('accepts a merge review that names the goal and adds no milestone', async () => {
    const { g, agent } = await fixture(false)
    await sql(db, 'INSERT INTO graph_agent_capabilities(agent_id,version,seen_at) VALUES(?,1,?)', agent, Date.now()).run()
    await run(db, g.id, 'run')
    await tick(env(), g.id)
    await deliver(
      g.id,
      agent,
      JSON.stringify({ subgoals: [{ title: 'Restate the goal', description: '', body: 'Everything the goal asks', necessity_confidence: 0.9 }] })
    )
    await tick(env(), g.id)
    const goal = (await rows<{ id: string }>(db, "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='goal'", g.id))[0].id
    await deliver(g.id, agent, JSON.stringify({ decision: 'equivalent', equivalent_node_id: goal, reason: 'same as the goal' }))
    await tick(env(), g.id)
    const proposals = await rows<{ status: string }>(db, 'SELECT status FROM graph_proposals WHERE graph_id=?', g.id)
    expect(proposals.map((p) => p.status)).toEqual(['published'])
    expect(await rows(db, "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='milestone'", g.id)).toHaveLength(0)
  })
})

import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { db, env, fixture, deliver, setupGraphHarness, teardownGraphHarness } from './test-harness.js'
import { graph, sql, rows, commit, assignment, type Assignment } from './store.js'
import { resource } from './mutations.js'
import { run, tick } from './engine.js'
import { similarMilestone, actionLedger } from './dedup.js'

beforeAll(setupGraphHarness, 30000)
afterAll(teardownGraphHarness)

// A synthetic graph shaped like the production failure: several planners, run after run, keep proposing
// the same few intents in different words. Four real intents exist; everything else is a rewording.
const intents = {
  uploader: {
    title: 'Add retry to uploader',
    body: 'Make the uploader retry failed chunks',
    steps: ['Edit uploader.ts to retry failed chunks', 'Run the uploader tests'],
    effects: ['Uploader retries failed chunks']
  },
  keys: {
    title: 'Rotate signing keys',
    body: 'Rotate the signing keys for the API',
    steps: ['Run the rotate script for signing keys', 'Publish the new public key'],
    effects: ['New signing key is published']
  },
  limiter: {
    title: 'Add rate limiter to API',
    body: 'Throttle abusive clients at the gateway',
    steps: ['Add a token bucket limiter to the gateway', 'Return 429 above the limit'],
    effects: ['Gateway throttles abusive clients']
  },
  cache: {
    title: 'Purge cache on deploy',
    body: 'Invalidate stale edge cache after each deploy',
    steps: ['Call the cache purge endpoint after deploy', 'Verify a fresh asset is served'],
    effects: ['Edge cache is purged after every deploy']
  }
}
type Intent = keyof typeof intents

const reworded: Record<Intent, { title: string; body: string; steps: string[]; effects: string[] }[]> = {
  uploader: [
    { title: 'Uploader: retry failed chunks', body: 'Retries for the uploader', steps: ['Edit uploader.ts so failed chunks retry', 'Run uploader tests'], effects: ['Failed chunks are retried by the uploader'] },
    { title: 'Retry failed chunks in the uploader', body: 'Make uploader retry chunks that failed', steps: ['Edit uploader.ts to retry the failed chunks', 'Run the uploader tests'], effects: ['The uploader retries failed chunks'] }
  ],
  keys: [
    { title: 'Signing keys rotation', body: 'Rotate API signing keys', steps: ['Run the rotate script for the signing keys', 'Publish the new public key'], effects: ['The new signing key is published'] },
    { title: 'Rotate the signing keys', body: 'Rotate the signing keys used by the API', steps: ['Run rotate script for signing keys', 'Publish new public key'], effects: ['New signing keys are published'] }
  ],
  limiter: [
    { title: 'Rate limiter for the API', body: 'Throttle abusive clients at gateway', steps: ['Add token bucket limiter to the gateway', 'Return 429 above limit'], effects: ['Gateway throttles abusive clients'] }
  ],
  cache: [
    { title: 'Purge the cache on every deploy', body: 'Invalidate stale edge cache after deploys', steps: ['Call cache purge endpoint after the deploy', 'Verify a fresh asset is served'], effects: ['Edge cache is purged after each deploy'] }
  ]
}

const action = (from: string, ref: string, t: { title: string; body: string; steps: string[]; effects: string[] }) => ({
  title: t.title,
  expected_quality: 0.7,
  description: '',
  body: t.body,
  from_id: from,
  baseline: 'cfg-v1',
  restoration_predicates: ['restored'],
  steps: t.steps,
  undo_steps: ['git revert'],
  cost: 1,
  recovery_cost: 1,
  resource_versions: [ref],
  effects: t.effects
})

async function seeded() {
  const { g, agent } = await fixture(false)
  await resource(db, g.id, { title: 'Source', description: '', body: 'Baseline', visibility: 'execution' })
  const source = (await rows<{ id: string }>(db, "SELECT id FROM graph_nodes WHERE graph_id=? AND kind='observed'", g.id))[0].id
  const ref = (await rows<{ id: string }>(db, 'SELECT id FROM graph_resources WHERE graph_id=?', g.id))[0].id
  await sql(db, 'INSERT INTO graph_agent_capabilities(agent_id,version,seen_at) VALUES(?,1,?)', agent, Date.now()).run()
  await run(db, g.id, 'run')
  await sql(db, "UPDATE graph_assignments SET status='cancelled' WHERE graph_id=? AND role='decompose'", g.id).run()
  return { g, agent, source, ref }
}

describe('graph dedup scenario: many planners, four real intents', () => {
  it('ends with one action per intent however often and however the planners reword them', async () => {
    const { g, agent, source, ref } = await seeded()
    let reviewed = 0
    let waves = 0
    // One planning wave: a planner assignment is queued and dispatched, it answers with `proposed`, and
    // the reviewer then judges whatever survived pre-review dedup.
    const wave = async (proposed: Intent[], variant: number) => {
      const gr = await graph(db, g.id)
      const plan = await assignment(db, gr, 'plan', { task: `wave ${waves++}`, observations: [], resources: [], attempted_actions: { actions: [], proposals: [] } })
      await commit(db, gr, `seed_plan_${waves}`, null, {}, plan.statements)
      // Executors are out of scope here; keep them from taking the agent.
      await sql(db, "UPDATE graph_assignments SET status='cancelled' WHERE graph_id=? AND role='execute' AND status='pending'", g.id).run()
      await sql(db, 'DELETE FROM graph_reservations WHERE graph_id=?', g.id).run()
      await tick(env(), g.id)
      const texts = proposed.map((k) => (variant === 0 ? intents[k] : reworded[k][(variant - 1) % reworded[k].length]))
      await deliver(g.id, agent, JSON.stringify({ actions: texts.map((t) => action(source, ref, t)) }))
      await tick(env(), g.id)
      let merges = await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='merge' ORDER BY created_at,id", g.id)
      while (reviewed < merges.length) {
        const input = JSON.parse(merges[reviewed].input) as { near_duplicates: { edge_id: string }[] }
        const named = input.near_duplicates[0]?.edge_id
        await deliver(
          g.id,
          agent,
          JSON.stringify(
            named
              ? { decision: 'duplicate_action', equivalent_node_id: null, duplicate_edge_id: named, reason: 'same intent' }
              : { decision: 'distinct', equivalent_node_id: null, reason: 'new' }
          )
        )
        await tick(env(), g.id)
        reviewed++
        await sql(db, "UPDATE graph_assignments SET status='cancelled' WHERE graph_id=? AND role='execute' AND status='pending'", g.id).run()
        await sql(db, 'DELETE FROM graph_reservations WHERE graph_id=?', g.id).run()
        merges = await rows<Assignment>(db, "SELECT * FROM graph_assignments WHERE graph_id=? AND role='merge' ORDER BY created_at,id", g.id)
      }
    }

    await wave(['uploader', 'keys', 'limiter'], 0) // three real intents
    await wave(['uploader', 'keys', 'limiter', 'cache'], 1) // three rewordings + one new intent
    await wave(['uploader', 'keys', 'cache'], 2) // rewordings only
    await wave(['uploader', 'keys', 'limiter', 'cache'], 1) // the same rewordings again, from a planner that never saw the ledger

    const edges = await rows<{ id: string; title: string }>(db, 'SELECT id,title FROM graph_edges WHERE graph_id=?', g.id)
    // "cache" first appears in wave 2 already reworded, so the survivor carries that wording.
    expect(edges.map((e) => e.title).sort()).toEqual(['Add rate limiter to API', 'Add retry to uploader', 'Purge the cache on every deploy', 'Rotate signing keys'].sort())

    // Every repeat was either dropped before review or named a duplicate in review; none became an action.
    const proposals = await rows<{ status: string }>(db, 'SELECT status FROM graph_proposals WHERE graph_id=?', g.id)
    const dropped = proposals.filter((p) => p.status === 'rejected').length
    const published = proposals.filter((p) => p.status === 'published').length
    expect(proposals).toHaveLength(14)
    expect(published + dropped).toBe(14)
    expect(dropped).toBeGreaterThanOrEqual(7)
    // The reviewer is only spent on intents that are new, or genuinely ambiguous.
    expect(reviewed).toBeLessThanOrEqual(14 - dropped)

    // Each edge carries a fingerprint, so a later `dedup` has nothing to fold.
    const fps = await rows<{ fingerprint: string | null }>(db, 'SELECT fingerprint FROM graph_plans')
    expect(fps.filter((f) => f.fingerprint)).toHaveLength(4)
    await run(db, g.id, 'dedup')
    expect(await rows(db, 'SELECT id FROM graph_edges WHERE graph_id=?', g.id)).toHaveLength(4)
  }, 30_000)
})

describe('milestone dedup', () => {
  const boiler = 'Scope: "Sandbox - task results only". Text only: no files changed, no emails sent, no external services. Record the draft in the task result for the same fictional note-taking app.'
  const milestone = (title: string) => ({ kind: 'milestone', title, body: `Write a short plain-text email. ${boiler}`, parent_id: null })

  it('keeps sibling milestones that differ only in their subject, and still folds a reworded title', async () => {
    const { g } = await seeded()
    const gr = await graph(db, g.id)
    const ids: Record<string, string> = {}
    for (const title of ['Draft welcome email', 'Draft day-3 tips email']) {
      const id = crypto.randomUUID()
      ids[title] = id
      await commit(db, gr, 'seed_milestone', null, {}, [
        sql(db, "INSERT INTO graph_nodes(id,graph_id,kind,title,description,body,created_at) VALUES(?,?,'milestone',?,'',?,0)", id, g.id, title, milestone(title).body),
        sql(db, "INSERT INTO graph_node_states(graph_id,node_id,state,created_at) VALUES(?,?,'active',0)", g.id, id)
      ])
    }
    const g2 = await graph(db, g.id)
    // Shared boilerplate must not make a new sibling look like a duplicate.
    const sibling = await similarMilestone(db, g2, milestone('Draft day-7 nudge email'))
    expect(sibling.some((m) => m.duplicate)).toBe(false)
    // A real rewording of an existing title is still folded.
    const reworded = await similarMilestone(db, g2, milestone('Draft the welcome email'))
    expect(reworded.find((m) => m.id === ids['Draft welcome email'])?.duplicate).toBe(true)
  })
})

describe('attempted-action ledger', () => {
  it('leaves out the action under review so a grader never sees its own work as an earlier attempt', async () => {
    const { g, source, ref } = await seeded()
    const gr = await graph(db, g.id)
    const edges: string[] = []
    for (const title of ['Add retry to uploader', 'Rotate signing keys']) {
      const target = crypto.randomUUID(),
        edge = crypto.randomUUID()
      edges.push(edge)
      await commit(db, gr, 'seed_edge', null, {}, [
        sql(db, "INSERT INTO graph_nodes(id,graph_id,kind,title,description,body,created_at) VALUES(?,?,'outcome',?,'','b',0)", target, g.id, title),
        sql(db, "INSERT INTO graph_node_states(graph_id,node_id,state,created_at) VALUES(?,?,'active',0)", g.id, target),
        sql(db, "INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at) VALUES(?,?,?,?,?,'','','x',?)", edge, g.id, source, target, title, Date.now()),
        sql(db, "INSERT INTO graph_plans(edge_id,baseline,predicates,steps,undo_steps,cost,recovery_cost,resource_versions,effects) VALUES(?,?,?,?,?,1,1,?,?)", edge, 'b', '[]', '["s"]', '[]', JSON.stringify([ref]), '["e"]')
      ])
    }
    const all = (await actionLedger(db, g.id)) as { actions: { edge_id: string }[] }
    expect(all.actions.map((a) => a.edge_id).sort()).toEqual([...edges].sort())
    const others = (await actionLedger(db, g.id, undefined, edges[0])) as { actions: { edge_id: string }[] }
    expect(others.actions.map((a) => a.edge_id)).toEqual([edges[1]])
  })
})

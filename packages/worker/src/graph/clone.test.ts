import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { db, fixture, setupGraphHarness, teardownGraphHarness } from './test-harness.js'
import { rows, create, configuration } from './store.js'
import { run } from './engine.js'
import { resource } from './mutations.js'
import { clone } from './clone.js'

beforeAll(setupGraphHarness, 30000)
afterAll(teardownGraphHarness)

describe('graph clone', () => {
  it('keeps resource version chains so only the newest version is current', async () => {
    const { g, user, team } = await fixture()
    await resource(db, g.id, { title: 'Doc', description: '', body: 'v1', visibility: 'execution' })
    const [first] = await rows<{ id: string }>(db, "SELECT id FROM graph_resources WHERE graph_id=? AND title='Doc'", g.id)
    await resource(db, g.id, {
      title: 'Doc',
      description: '',
      body: 'v2',
      visibility: 'execution',
      supersedes_id: first.id
    })
    await run(db, g.id, 'stop')
    const copy = await clone(db, team, user, g.id, true)
    const copied = await rows<{ id: string; body: string; supersedes_id: string | null }>(
      db,
      "SELECT id,body,supersedes_id FROM graph_resources WHERE graph_id=? AND title='Doc' ORDER BY version",
      copy.id
    )
    expect(copied.map((r) => r.body)).toEqual(['v1', 'v2'])
    expect(copied[0].supersedes_id).toBeNull()
    expect(copied[1].supersedes_id).toBe(copied[0].id)
  })
})

describe('graph create', () => {
  it('stores the success rule NFC-normalized so evidence can match it', async () => {
    const f = await fixture()
    const made = await create(db, f.team, f.user, {
      title: 'Goal',
      description: '',
      body: 'Target',
      start_state: 'Baseline',
      rule: { op: 'AND', predicates: ['café'], scope: 'café' },
      policy: { agents: [f.agent], grader: f.agent, decomposer: f.agent, review: false }
    })
    const { rule } = await configuration(db, made)
    expect(rule.predicates).toEqual(['café'])
    expect(rule.scope).toBe('café')
  })
})

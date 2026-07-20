import { describe, it, expect, beforeEach } from 'vitest'
import { daemonPush, list, get, search, rollups, daemonRollup } from './memory.js'
import { withDaemonAgentAuth, sha256 } from '../auth.js'
import type { Env, AuthContext, DaemonContext } from '../types.js'

// ── Minimal in-memory D1 fake ─────────────────────────────────────────────────
// Backs the exact SQL statements memory.ts and (for the daemon-auth test)
// auth.ts issue against team_members/agents/users/user_cli_tokens/tags/memory/
// memory_tags. Not a generic SQL engine — each statement is recognized by a
// normalized-text match against the literal SQL in memory.ts/auth.ts and
// executed against plain arrays, closely enough (including the
// UNIQUE(team_id, name) constraint on tags) to exercise the real route code
// rather than a mirrored copy of it.

function norm(sql: string) { return sql.replace(/\s+/g, ' ').trim() }

interface TagRow { id: string; team_id: string; name: string; created_at: number }
interface MemoryRow { id: string; team_id: string; agent_id: string | null; category: string; title: string; content: string; created_at: number; updated_at: number }
interface MemoryTagRow { memory_id: string; tag_id: string }
interface MemoryRollupRow { id: string; team_id: string; period: string; period_key: string; content: string; created_at: number }
interface TeamMemberRow { team_id: string; user_id: string; role: string }
interface AgentRow { id: string; team_id: string }
interface UserRow { id: string; firebase_uid: string; email: string; plan: string }
interface CliTokenRow { id: string; user_id: string; token_hash: string; expires_at: number }

class FakeDB {
  tags: TagRow[] = []
  memory: MemoryRow[] = []
  memoryTags: MemoryTagRow[] = []
  memoryRollups: MemoryRollupRow[] = []
  teamMembers: TeamMemberRow[] = []
  agents: AgentRow[] = []
  users: UserRow[] = []
  cliTokens: CliTokenRow[] = []

  prepare(sql: string) {
    const s = norm(sql)
    const db = this
    let bound: unknown[] = []
    const api = {
      bind(...args: unknown[]) { bound = args; return api },
      async first<T>(): Promise<T | null> { return db.dispatchFirst(s, bound) as T | null },
      async all<T>() { return { results: db.dispatchAll(s, bound) as T[] } },
      async run() { return db.dispatchRun(s, bound) },
    }
    return api
  }

  async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
    const results = []
    for (const stmt of stmts) results.push(await stmt.run())
    return results
  }

  private tagNamesFor(memoryId: string): string[] {
    return this.memoryTags
      .filter(mt => mt.memory_id === memoryId)
      .map(mt => this.tags.find(t => t.id === mt.tag_id)?.name)
      .filter((n): n is string => !!n)
  }

  private dispatchFirst(sql: string, args: unknown[]): unknown {
    if (sql === 'SELECT id FROM tags WHERE team_id = ? AND name = ?') {
      const [teamId, name] = args as [string, string]
      const hit = this.tags.find(t => t.team_id === teamId && t.name === name)
      return hit ? { id: hit.id } : null
    }
    if (sql === 'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?') {
      const [teamId, userId] = args as [string, string]
      const hit = this.teamMembers.find(m => m.team_id === teamId && m.user_id === userId)
      return hit ? { role: hit.role } : null
    }
    if (sql.startsWith('SELECT m.*, json_group_array')) {
      const [memoryId, teamId] = args as [string, string]
      const row = this.memory.find(m => m.id === memoryId && m.team_id === teamId)
      if (!row) return null
      return { ...row, tags: JSON.stringify(this.tagNamesFor(row.id)) }
    }
    if (sql.includes('FROM user_cli_tokens t') && sql.includes('JOIN users u')) {
      const [tokenHash] = args as [string]
      const token = this.cliTokens.find(t => t.token_hash === tokenHash)
      if (!token) return null
      const user = this.users.find(u => u.id === token.user_id)
      if (!user) return null
      return { id: token.id, user_id: token.user_id, expires_at: token.expires_at, firebase_uid: user.firebase_uid, email: user.email, plan: user.plan }
    }
    if (sql.startsWith('SELECT a.team_id')) {
      const [agentId, userId] = args as [string, string]
      const agent = this.agents.find(a => a.id === agentId)
      if (!agent) return null
      const member = this.teamMembers.find(m => m.team_id === agent.team_id && m.user_id === userId)
      return member ? { team_id: agent.team_id } : null
    }
    if (sql === 'SELECT content, period_key FROM memory_rollup WHERE team_id = ? AND period = ? ORDER BY period_key DESC LIMIT 1') {
      const [teamId, period] = args as [string, string]
      const hit = this.memoryRollups
        .filter(r => r.team_id === teamId && r.period === period)
        .sort((a, b) => (a.period_key < b.period_key ? 1 : -1))[0]
      return hit ? { content: hit.content, period_key: hit.period_key } : null
    }
    throw new Error(`FakeDB: unhandled first() query: ${sql}`)
  }

  private dispatchAll(sql: string, args: unknown[]): unknown[] {
    if (sql.startsWith('SELECT m.id, m.team_id, m.agent_id, m.category, m.title, m.content, m.created_at, m.updated_at,')) {
      const [teamId, category] = args as [string, string | null]
      return this.memory
        .filter(m => m.team_id === teamId && (category == null || m.category === category))
        .sort((a, b) => b.created_at - a.created_at)
        .map(m => ({ ...m, tags: JSON.stringify(this.tagNamesFor(m.id)) }))
    }
    if (sql.startsWith('SELECT DISTINCT m.id, m.team_id, m.agent_id, m.category, m.title, m.content, m.created_at, m.updated_at')) {
      const [teamId, titleLike] = args as [string, string]
      const q = String(titleLike).replace(/^%|%$/g, '')
      return this.memory
        .filter(m => m.team_id === teamId && (m.title.includes(q) || m.content.includes(q) || this.tagNamesFor(m.id).some(n => n.includes(q))))
        .sort((a, b) => b.created_at - a.created_at)
    }
    if (sql.startsWith('SELECT id, team_id, period, period_key, content, created_at FROM memory_rollup')) {
      const [teamId, period] = args as [string, string]
      return this.memoryRollups
        .filter(r => r.team_id === teamId && r.period === period)
        .sort((a, b) => (a.period_key < b.period_key ? 1 : -1))
    }
    throw new Error(`FakeDB: unhandled all() query: ${sql}`)
  }

  private dispatchRun(sql: string, args: unknown[]): { meta: { changes: number } } {
    if (sql.startsWith('INSERT INTO tags (id, team_id, name, created_at) SELECT')) {
      const [id, teamId, name, createdAt, countTeamId, max] = args as [string, string, string, number, string, number]
      if (this.tags.some(t => t.team_id === teamId && t.name === name)) {
        throw new Error('UNIQUE constraint failed: tags.team_id, tags.name')
      }
      const count = this.tags.filter(t => t.team_id === countTeamId).length
      if (count >= max) return { meta: { changes: 0 } }
      this.tags.push({ id, team_id: teamId, name, created_at: createdAt })
      return { meta: { changes: 1 } }
    }
    if (sql === 'INSERT INTO memory (id, team_id, agent_id, category, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)') {
      const [id, teamId, agentId, category, title, content, createdAt, updatedAt] = args as [string, string, string | null, string, string, string, number, number]
      this.memory.push({ id, team_id: teamId, agent_id: agentId, category, title, content, created_at: createdAt, updated_at: updatedAt })
      return { meta: { changes: 1 } }
    }
    if (sql === 'INSERT INTO memory_tags (memory_id, tag_id) VALUES (?, ?)') {
      const [memoryId, tagId] = args as [string, string]
      this.memoryTags.push({ memory_id: memoryId, tag_id: tagId })
      return { meta: { changes: 1 } }
    }
    if (sql.startsWith('UPDATE user_cli_tokens SET last_used')) {
      return { meta: { changes: 1 } }
    }
    throw new Error(`FakeDB: unhandled run() query: ${sql}`)
  }
}

function makeEnv(db: FakeDB): Env {
  return { DB: db as unknown as D1Database } as unknown as Env
}

const AUTH: AuthContext = { uid: 'fb-1', email: 'user@example.com', userId: 'user-1', plan: 'free' }
const DAEMON: DaemonContext = { teamId: 'team-1', agentId: 'agent-1', tokenId: '' }

let db: FakeDB
beforeEach(() => {
  db = new FakeDB()
  db.teamMembers.push({ team_id: 'team-1', user_id: 'user-1', role: 'member' })
})

// ── daemonPush ─────────────────────────────────────────────────────────────────

describe('daemonPush', () => {
  it('creates a memory row with no tags', async () => {
    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      body: JSON.stringify({ category: 'architecture', title: 'Worker uses D1', content: 'Notes on D1 usage.' }),
    })
    const res = await daemonPush(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; category: string; title: string }
    expect(body.category).toBe('architecture')
    expect(body.title).toBe('Worker uses D1')
    expect(db.memory).toHaveLength(1)
    expect(db.memory[0].team_id).toBe('team-1')
    expect(db.memory[0].agent_id).toBe('agent-1')
  })

  it('creates and links tags, reusing an existing tag by name', async () => {
    db.tags.push({ id: 'tag-existing', team_id: 'team-1', name: 'db', created_at: 1 })

    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      body: JSON.stringify({ category: 'structure', title: 'Repo layout', content: 'Three packages.', tags: ['db', 'onboarding'] }),
    })
    const res = await daemonPush(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(201)

    expect(db.tags.filter(t => t.name === 'db')).toHaveLength(1) // reused, not duplicated
    expect(db.tags.some(t => t.name === 'onboarding')).toBe(true)
    expect(db.memoryTags).toHaveLength(2)
  })

  it('rejects an invalid category', async () => {
    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      body: JSON.stringify({ category: 'random', title: 'x', content: 'y' }),
    })
    const res = await daemonPush(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_category')
    expect(db.memory).toHaveLength(0)
  })

  it('rejects a missing category the same as an invalid one', async () => {
    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      body: JSON.stringify({ title: 'x', content: 'y' }),
    })
    const res = await daemonPush(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_category')
  })

  it('rejects missing title/content', async () => {
    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      body: JSON.stringify({ category: 'events', title: '', content: '' }),
    })
    const res = await daemonPush(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('missing_fields')
  })

  it('rejects a tag containing a space', async () => {
    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      body: JSON.stringify({ category: 'events', title: 'x', content: 'y', tags: ['has space'] }),
    })
    const res = await daemonPush(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_tag')
    expect(db.memory).toHaveLength(0)
  })

  it('rejects a tag longer than 30 characters', async () => {
    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      body: JSON.stringify({ category: 'events', title: 'x', content: 'y', tags: ['a'.repeat(31)] }),
    })
    const res = await daemonPush(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_tag')
  })

  it('enforces the 1000-tags-per-team cap atomically, before writing the memory row', async () => {
    for (let i = 0; i < 1000; i++) {
      db.tags.push({ id: `tag-${i}`, team_id: 'team-1', name: `tag-${i}`, created_at: 1 })
    }

    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      body: JSON.stringify({ category: 'events', title: 'x', content: 'y', tags: ['brand-new-tag'] }),
    })
    const res = await daemonPush(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(429)
    expect((await res.json() as { error: string }).error).toBe('tag_limit_reached')
    // No orphaned memory row left behind when the tag limit blocks the push.
    expect(db.memory).toHaveLength(0)
    expect(db.tags).toHaveLength(1000)
  })

  it('does not count against the cap when reusing an existing tag at the limit', async () => {
    for (let i = 0; i < 1000; i++) {
      db.tags.push({ id: `tag-${i}`, team_id: 'team-1', name: `tag-${i}`, created_at: 1 })
    }
    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      body: JSON.stringify({ category: 'events', title: 'x', content: 'y', tags: ['tag-5'] }),
    })
    const res = await daemonPush(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(201)
    expect(db.memory).toHaveLength(1)
  })
})

// ── list / get ─────────────────────────────────────────────────────────────────

describe('list', () => {
  beforeEach(() => {
    db.memory.push(
      { id: 'mem-1', team_id: 'team-1', agent_id: 'agent-1', category: 'architecture', title: 'A', content: 'a', created_at: 100, updated_at: 100 },
      { id: 'mem-2', team_id: 'team-1', agent_id: 'agent-1', category: 'events', title: 'B', content: 'b', created_at: 200, updated_at: 200 },
      { id: 'mem-3', team_id: 'team-2', agent_id: 'agent-2', category: 'architecture', title: 'C', content: 'c', created_at: 300, updated_at: 300 },
    )
    db.tags.push({ id: 'tag-1', team_id: 'team-1', name: 'infra', created_at: 1 })
    db.memoryTags.push({ memory_id: 'mem-1', tag_id: 'tag-1' })
  })

  it('returns only the caller team\'s entries, newest first, with tags attached', async () => {
    const req = new Request('https://api.example.com/teams/team-1/memory')
    const res = await list(req, makeEnv(db), {}, AUTH)
    expect(res.status).toBe(200)
    const body = await res.json() as { memory: Array<{ id: string; tags: string[] }> }
    expect(body.memory.map(m => m.id)).toEqual(['mem-2', 'mem-1'])
    expect(body.memory.find(m => m.id === 'mem-1')?.tags).toEqual(['infra'])
    expect(body.memory.find(m => m.id === 'mem-2')?.tags).toEqual([])
  })

  it('filters by category', async () => {
    const req = new Request('https://api.example.com/teams/team-1/memory?category=architecture')
    const res = await list(req, makeEnv(db), {}, AUTH)
    const body = await res.json() as { memory: Array<{ id: string }> }
    expect(body.memory.map(m => m.id)).toEqual(['mem-1'])
  })

  it('rejects an invalid category filter', async () => {
    const req = new Request('https://api.example.com/teams/team-1/memory?category=bogus')
    const res = await list(req, makeEnv(db), {}, AUTH)
    expect(res.status).toBe(400)
  })

  it('returns not_found for a non-member', async () => {
    const req = new Request('https://api.example.com/teams/team-1/memory')
    const res = await list(req, makeEnv(db), {}, { ...AUTH, userId: 'stranger' })
    expect(res.status).toBe(404)
  })
})

describe('get', () => {
  beforeEach(() => {
    db.memory.push({ id: 'mem-1', team_id: 'team-1', agent_id: 'agent-1', category: 'architecture', title: 'A', content: 'a', created_at: 100, updated_at: 100 })
    db.tags.push({ id: 'tag-1', team_id: 'team-1', name: 'infra', created_at: 1 })
    db.memoryTags.push({ memory_id: 'mem-1', tag_id: 'tag-1' })
  })

  it('returns a single entry with tags', async () => {
    const req = new Request('https://api.example.com/teams/team-1/memory/mem-1')
    const res = await get(req, makeEnv(db), {}, AUTH)
    expect(res.status).toBe(200)
    const body = await res.json() as { id: string; tags: string[] }
    expect(body.id).toBe('mem-1')
    expect(body.tags).toEqual(['infra'])
  })

  it('returns not_found for a missing id', async () => {
    const req = new Request('https://api.example.com/teams/team-1/memory/does-not-exist')
    const res = await get(req, makeEnv(db), {}, AUTH)
    expect(res.status).toBe(404)
  })
})

// ── search ──────────────────────────────────────────────────────────────────────

describe('search', () => {
  it('matches on title, content, or tag name, scoped to the daemon\'s own team', async () => {
    db.memory.push(
      { id: 'mem-1', team_id: 'team-1', agent_id: 'agent-1', category: 'architecture', title: 'Worker uses D1', content: 'irrelevant', created_at: 100, updated_at: 100 },
      { id: 'mem-2', team_id: 'team-2', agent_id: 'agent-2', category: 'architecture', title: 'D1 in another team', content: 'irrelevant', created_at: 200, updated_at: 200 },
    )
    const req = new Request('https://api.example.com/daemon/memory/search?q=D1')
    const res = await search(req, makeEnv(db), {}, DAEMON)
    const body = await res.json() as { memory: Array<{ id: string }> }
    expect(body.memory.map(m => m.id)).toEqual(['mem-1'])
  })

  it('requires a query', async () => {
    const req = new Request('https://api.example.com/daemon/memory/search')
    const res = await search(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(400)
  })
})

// ── rollups ───────────────────────────────────────────────────────────────────

describe('rollups', () => {
  beforeEach(() => {
    db.memoryRollups.push(
      { id: 'r-1', team_id: 'team-1', period: 'daily', period_key: '2026-07-10', content: 'day 1', created_at: 100 },
      { id: 'r-2', team_id: 'team-1', period: 'daily', period_key: '2026-07-11', content: 'day 2', created_at: 200 },
      { id: 'r-3', team_id: 'team-1', period: 'weekly', period_key: '2026-W28', content: 'week 1', created_at: 200 },
      { id: 'r-4', team_id: 'team-2', period: 'daily', period_key: '2026-07-11', content: 'other team', created_at: 200 },
    )
  })

  it('returns the caller team\'s daily rollups newest period_key first, by default', async () => {
    const req = new Request('https://api.example.com/teams/team-1/rollups')
    const res = await rollups(req, makeEnv(db), {}, AUTH)
    expect(res.status).toBe(200)
    const body = await res.json() as { rollups: Array<{ id: string }> }
    expect(body.rollups.map(r => r.id)).toEqual(['r-2', 'r-1'])
  })

  it('filters by period=weekly', async () => {
    const req = new Request('https://api.example.com/teams/team-1/rollups?period=weekly')
    const res = await rollups(req, makeEnv(db), {}, AUTH)
    const body = await res.json() as { rollups: Array<{ id: string }> }
    expect(body.rollups.map(r => r.id)).toEqual(['r-3'])
  })

  it('returns not_found for a non-member', async () => {
    const req = new Request('https://api.example.com/teams/team-1/rollups')
    const res = await rollups(req, makeEnv(db), {}, { ...AUTH, userId: 'stranger' })
    expect(res.status).toBe(404)
  })
})

// ── daemonRollup ──────────────────────────────────────────────────────────────

describe('daemonRollup', () => {
  beforeEach(() => {
    db.memoryRollups.push(
      { id: 'r-1', team_id: 'team-1', period: 'daily', period_key: '2026-07-10', content: 'day 1', created_at: 100 },
      { id: 'r-2', team_id: 'team-1', period: 'daily', period_key: '2026-07-11', content: 'day 2', created_at: 200 },
      { id: 'r-3', team_id: 'team-2', period: 'daily', period_key: '2026-07-12', content: 'other team', created_at: 300 },
    )
  })

  it('returns the latest daily rollup content for the authenticated team', async () => {
    const req = new Request('https://api.example.com/daemon/memory/rollup?period=daily')
    const res = await daemonRollup(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: string; period_key: string | null }
    expect(body).toEqual({ content: 'day 2', period_key: '2026-07-11' })
  })

  it('returns empty content and a null period_key when none exists', async () => {
    const req = new Request('https://api.example.com/daemon/memory/rollup?period=weekly')
    const res = await daemonRollup(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: string; period_key: string | null }
    expect(body).toEqual({ content: '', period_key: null })
  })

  it('ignores other teams\' rollups', async () => {
    const req = new Request('https://api.example.com/daemon/memory/rollup?period=daily')
    const res = await daemonRollup(req, makeEnv(db), {}, { ...DAEMON, teamId: 'team-2' })
    const body = await res.json() as { content: string; period_key: string | null }
    expect(body).toEqual({ content: 'other team', period_key: '2026-07-12' })
  })
})

// ── /daemon/memory requires daemon auth ──────────────────────────────────────
// daemonPush/search are wrapped by daemonRoute (index.ts), which resolves the
// DaemonContext via withDaemonAgentAuth before either handler runs. Exercised
// directly here against the same FakeDB rather than mirrored, since
// withDaemonAgentAuth is exactly what stands between an unauthenticated
// request and memory.ts.

describe('withDaemonAgentAuth (gates /daemon/memory)', () => {
  const RAW_TOKEN = 'tsq_cli_test-token'

  async function seedValidToken() {
    db.users.push({ id: 'user-1', firebase_uid: 'fb-1', email: 'user@example.com', plan: 'free' })
    db.cliTokens.push({ id: 'token-1', user_id: 'user-1', token_hash: await sha256(RAW_TOKEN), expires_at: Date.now() + 1_000_000 })
  }

  it('rejects requests with no Authorization header at all', async () => {
    const req = new Request('https://api.example.com/daemon/memory', { method: 'POST' })
    const result = await withDaemonAgentAuth(req, makeEnv(db))
    expect(result instanceof Response).toBe(true)
    expect((result as Response).status).toBe(401)
  })

  it('rejects a request missing X-TSQ-Agent even with a valid token', async () => {
    await seedValidToken()
    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RAW_TOKEN}` },
    })
    const result = await withDaemonAgentAuth(req, makeEnv(db))
    expect(result instanceof Response).toBe(true)
    expect((result as Response).status).toBe(400)
  })

  it('rejects an agent not owned by the authenticated user\'s team', async () => {
    await seedValidToken()
    db.agents.push({ id: 'agent-1', team_id: 'team-other' }) // no team_members row for user-1/team-other
    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RAW_TOKEN}`, 'X-TSQ-Agent': 'agent-1' },
    })
    const result = await withDaemonAgentAuth(req, makeEnv(db))
    expect(result instanceof Response).toBe(true)
    expect((result as Response).status).toBe(403)
  })

  it('resolves a DaemonContext for a valid token + owned agent', async () => {
    await seedValidToken()
    db.agents.push({ id: 'agent-1', team_id: 'team-1' })
    const req = new Request('https://api.example.com/daemon/memory', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RAW_TOKEN}`, 'X-TSQ-Agent': 'agent-1' },
    })
    const result = await withDaemonAgentAuth(req, makeEnv(db))
    expect(result).toEqual({ teamId: 'team-1', agentId: 'agent-1', tokenId: '' })
  })
})

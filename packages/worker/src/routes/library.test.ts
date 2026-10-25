import { describe, it, expect } from 'vitest'
import * as skills from './skills.js'
import * as commands from './commands.js'
import * as subAgents from './sub-agents.js'
import type { Env, AuthContext, DaemonContext } from '../types.js'

// ── Minimal in-memory D1 fake ─────────────────────────────────────────────────
// One table per library kind plus team_members. Queries are routed by shape, which is
// enough to cover the membership/role checks and the reads/writes behind them.

function norm(sql: string) { return sql.replace(/\s+/g, ' ').trim() }

interface Item { id: string; team_id: string; name: string; auto_install: number; is_default: number; version: number; content: string }

class FakeDB {
  members = [
    { team_id: 'team-1', user_id: 'owner', role: 'owner' },
    { team_id: 'team-1', user_id: 'maint', role: 'maintainer' },
    { team_id: 'team-1', user_id: 'member', role: 'member' },
  ]
  tables: Record<string, Item[]> = { skills: [], commands: [], sub_agents: [] }

  prepare(sql: string) {
    const s = norm(sql)
    const db = this
    let args: unknown[] = []
    const api = {
      bind(...a: unknown[]) { args = a; return api },
      async first() { return db.first(s, args) },
      async run() { return db.run(s, args) },
    }
    return api
  }

  private table(sql: string): Item[] {
    const t = Object.keys(this.tables).find(t => sql.includes(` ${t} `) || sql.endsWith(` ${t}`))
    if (!t) throw new Error(`FakeDB: no table in ${sql}`)
    return this.tables[t]
  }

  private first(sql: string, args: unknown[]): unknown {
    if (sql === 'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?') {
      return this.members.find(m => m.team_id === args[0] && m.user_id === args[1]) ?? null
    }
    if (sql === "SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND role IN ('owner', 'maintainer')") {
      return this.members.some(m => m.team_id === args[0] && m.user_id === args[1] && (m.role === 'owner' || m.role === 'maintainer')) ? { 1: 1 } : null
    }
    if (/^SELECT id, version, auto_install FROM \w+ WHERE team_id = \? AND name = \?$/.test(sql)) {
      return this.table(sql).find(i => i.team_id === args[0] && i.name === args[1]) ?? null
    }
    if (sql === 'SELECT id, version, auto_install FROM skills WHERE name = ? AND team_id = ?') {
      return this.tables.skills.find(i => i.name === args[0] && i.team_id === args[1]) ?? null
    }
    if (sql === 'SELECT id FROM skills WHERE name = ? AND is_default = 1 LIMIT 1') return null
    if (/^SELECT (id, )?is_default, team_id, auto_install FROM \w+ WHERE id = \?$/.test(sql)) {
      return this.table(sql).find(i => i.id === args[0]) ?? null
    }
    throw new Error(`FakeDB: unhandled first() query: ${sql}`)
  }

  private run(sql: string, args: unknown[]): { meta: { changes: number } } {
    const rows = this.table(sql)
    if (sql.startsWith('INSERT INTO')) {
      rows.push({ id: String(args[0]), team_id: String(args[1]), name: String(args[2]), auto_install: 0, is_default: 0, version: 1, content: String(args[4]) })
      return { meta: { changes: 1 } }
    }
    if (sql.startsWith('UPDATE')) {
      const item = rows.find(i => i.id === args[args.length - 1])
      if (item) item.version += 1
      return { meta: { changes: item ? 1 : 0 } }
    }
    if (sql.startsWith('DELETE')) {
      const before = rows.length
      this.tables[Object.keys(this.tables).find(t => this.tables[t] === rows)!] = rows.filter(i => i.id !== args[0])
      return { meta: { changes: before - rows.length } }
    }
    throw new Error(`FakeDB: unhandled run() query: ${sql}`)
  }
}

const user = (userId: string): AuthContext => ({ uid: `fb-${userId}`, email: `${userId}@example.com`, userId, plan: 'free' })
const env = (db: FakeDB) => ({ DB: db as unknown as D1Database } as unknown as Env)
const send = (path: string, method: string, body?: unknown) =>
  new Request(`https://api.example.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })

const KINDS = [
  { name: 'skills', mod: skills, table: 'skills', path: 'skills' },
  { name: 'commands', mod: commands, table: 'commands', path: 'commands' },
  { name: 'sub-agents', mod: subAgents, table: 'sub_agents', path: 'sub-agents' },
] as const

function seedItem(db: FakeDB, table: string, autoInstall: number): Item {
  const item = { id: 'item-1', team_id: 'team-1', name: 'deploy', auto_install: autoInstall, is_default: 0, version: 1, content: 'x' }
  db.tables[table].push(item)
  return item
}

describe.each(KINDS)('$name library rules', ({ mod, table, path }) => {
  const base = `/teams/team-1/${path}`

  it('rejects names that are not a single safe path segment', async () => {
    for (const name of ['../escape', 'a/b', '.hidden', 'a.b', '-x', 'x'.repeat(101)]) {
      const res = await mod.create(send(base, 'POST', { name, content: 'c' }), env(new FakeDB()), {}, user('owner'))
      expect(res.status, name).toBe(400)
    }
  })

  it('lets members create items that are not auto-installed', async () => {
    const db = new FakeDB()
    const res = await mod.create(send(base, 'POST', { name: 'notes', content: 'c' }), env(db), {}, user('member'))
    expect(res.status).toBe(201)
  })

  it('stops members from creating auto-install items', async () => {
    const db = new FakeDB()
    const res = await mod.create(send(base, 'POST', { name: 'deploy', content: 'c', auto_install: true }), env(db), {}, user('member'))
    expect(res.status).toBe(403)
    expect(db.tables[table]).toHaveLength(0)
  })

  it('lets maintainers create auto-install items', async () => {
    const res = await mod.create(send(base, 'POST', { name: 'deploy', content: 'c', auto_install: true }), env(new FakeDB()), {}, user('maint'))
    expect(res.status).toBe(201)
  })

  it('stops members from overwriting an auto-install item through create', async () => {
    const db = new FakeDB()
    seedItem(db, table, 1)
    const res = await mod.create(send(base, 'POST', { name: 'deploy', content: 'evil' }), env(db), {}, user('member'))
    expect(res.status).toBe(403)
    expect(db.tables[table][0].version).toBe(1)
  })

  it('stops members from editing an auto-install item', async () => {
    const db = new FakeDB()
    seedItem(db, table, 1)
    const res = await mod.update(send(`${base}/item-1`, 'PUT', { content: 'evil' }), env(db), {}, user('member'))
    expect(res.status).toBe(403)
    expect(db.tables[table][0].version).toBe(1)
  })

  it('stops members from turning auto-install on', async () => {
    const db = new FakeDB()
    seedItem(db, table, 0)
    const res = await mod.update(send(`${base}/item-1`, 'PUT', { auto_install: true }), env(db), {}, user('member'))
    expect(res.status).toBe(403)
  })

  it('lets members edit items that are not auto-installed', async () => {
    const db = new FakeDB()
    seedItem(db, table, 0)
    const res = await mod.update(send(`${base}/item-1`, 'PUT', { content: 'new' }), env(db), {}, user('member'))
    expect(res.status).toBe(200)
  })

  it('rejects renaming to an unsafe name', async () => {
    const db = new FakeDB()
    seedItem(db, table, 0)
    const res = await mod.update(send(`${base}/item-1`, 'PUT', { name: '../../x' }), env(db), {}, user('owner'))
    expect(res.status).toBe(400)
  })

  it('stops members from deleting an auto-install item', async () => {
    const db = new FakeDB()
    seedItem(db, table, 1)
    const res = await mod.remove(send(`${base}/item-1`, 'DELETE'), env(db), {}, user('member'))
    expect(res.status).toBe(403)
    expect(db.tables[table]).toHaveLength(1)
  })

  it('lets owners delete an auto-install item', async () => {
    const db = new FakeDB()
    seedItem(db, table, 1)
    const res = await mod.remove(send(`${base}/item-1`, 'DELETE'), env(db), {}, user('owner'))
    expect(res.status).toBe(204)
  })
})

describe('skills.daemonUpsert', () => {
  const daemon = (userId: string): DaemonContext => ({ teamId: 'team-1', agentId: 'agent-1', userId, tokenId: '' })
  const upsert = (body: unknown) => send('/daemon/skills', 'POST', body)

  it('rejects unsafe names', async () => {
    const res = await skills.daemonUpsert(upsert({ name: 'tsq-../../x', content: 'c' }), env(new FakeDB()), {}, daemon('member'))
    expect(res.status).toBe(400)
  })

  it("stops a member's daemon from rewriting an auto-install skill", async () => {
    const db = new FakeDB()
    db.tables.skills.push({ id: 's1', team_id: 'team-1', name: 'tsq-learned', auto_install: 1, is_default: 0, version: 1, content: 'x' })
    const res = await skills.daemonUpsert(upsert({ name: 'tsq-learned', content: 'evil' }), env(db), {}, daemon('member'))
    expect(res.status).toBe(403)
    expect(db.tables.skills[0].version).toBe(1)
  })

  it("lets a member's daemon update a skill that is not auto-installed", async () => {
    const db = new FakeDB()
    db.tables.skills.push({ id: 's1', team_id: 'team-1', name: 'tsq-learned', auto_install: 0, is_default: 0, version: 1, content: 'x' })
    const res = await skills.daemonUpsert(upsert({ name: 'tsq-learned', content: 'new' }), env(db), {}, daemon('member'))
    expect(res.status).toBe(200)
  })

  it("lets a maintainer's daemon update an auto-install skill", async () => {
    const db = new FakeDB()
    db.tables.skills.push({ id: 's1', team_id: 'team-1', name: 'tsq-learned', auto_install: 1, is_default: 0, version: 1, content: 'x' })
    const res = await skills.daemonUpsert(upsert({ name: 'tsq-learned', content: 'new' }), env(db), {}, daemon('maint'))
    expect(res.status).toBe(200)
  })
})

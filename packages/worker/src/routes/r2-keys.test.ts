import { describe, it, expect } from 'vitest'
import { agentKeyPrefix, isAgentKey, isAgentUploadKey, sanitizeFilename } from './helpers.js'
import { messageAttach } from './daemon.js'
import type { Env, DaemonContext } from '../types.js'

// ── Minimal in-memory D1 fake ─────────────────────────────────────────────────
// Covers the lookups messageAttach and isAgentUploadKey issue before any write, so a
// rejected key is proven to be rejected before the message row is touched.

function norm(sql: string) { return sql.replace(/\s+/g, ' ').trim() }

class FakeDB {
  sessions: { id: string; agent_id: string }[] = []
  messages: { id: string; team_id: string; agent_id: string; transcript_key: string | null }[] = []

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

  private first(sql: string, args: unknown[]): unknown {
    if (sql === 'SELECT 1 FROM sessions WHERE id = ? AND agent_id = ?') {
      const [id, agentId] = args
      return this.sessions.some(s => s.id === id && s.agent_id === agentId) ? { 1: 1 } : null
    }
    if (sql === 'SELECT m.id FROM messages m JOIN tasks t ON m.task_id = t.id WHERE m.id = ? AND t.team_id = ? AND t.agent_id = ?') {
      const [id, teamId, agentId] = args
      const m = this.messages.find(m => m.id === id && m.team_id === teamId && m.agent_id === agentId)
      return m ? { id: m.id } : null
    }
    throw new Error(`FakeDB: unhandled first() query: ${sql}`)
  }

  private run(sql: string, args: unknown[]): { meta: { changes: number } } {
    if (sql === 'UPDATE messages SET transcript_key = ? WHERE id = ?') {
      const [key, id] = args as [string, string]
      const m = this.messages.find(m => m.id === id)
      if (m) m.transcript_key = key
      return { meta: { changes: m ? 1 : 0 } }
    }
    throw new Error(`FakeDB: unhandled run() query: ${sql}`)
  }
}

const AGENT = '01JABCDEFGHJKMNPQRSTVWXYZ0'
const OTHER_AGENT = '01JZZZZZZZZZZZZZZZZZZZZZZ9'
const PREFIX = agentKeyPrefix(AGENT)
const DAEMON: DaemonContext = { teamId: 'team-1', agentId: AGENT, userId: 'user-1', tokenId: '' }

function seed(): FakeDB {
  const db = new FakeDB()
  db.sessions.push({ id: 'sess-1', agent_id: AGENT }, { id: 'victim-sess', agent_id: OTHER_AGENT })
  db.messages.push({ id: 'msg-1', team_id: 'team-1', agent_id: AGENT, transcript_key: null })
  return db
}

function makeEnv(db: FakeDB): Env {
  return { DB: db as unknown as D1Database } as unknown as Env
}

function attach(db: FakeDB, body: unknown): Promise<Response> {
  const req = new Request('https://api.example.com/daemon/messages/msg-1/attach', { method: 'POST', body: JSON.stringify(body) })
  return messageAttach(req, makeEnv(db), {}, DAEMON)
}

describe('sanitizeFilename', () => {
  it('keeps safe names', () => {
    expect(sanitizeFilename('full.log', 'file')).toBe('full.log')
  })

  it('collapses path separators into one segment', () => {
    expect(sanitizeFilename('../../victim/full.log', 'file')).toBe('.._.._victim_full.log')
  })

  it('falls back for empty and dot-only names', () => {
    expect(sanitizeFilename('', 'file')).toBe('file')
    expect(sanitizeFilename('.', 'file')).toBe('file')
    expect(sanitizeFilename('..', 'file')).toBe('file')
  })
})

describe('isAgentKey', () => {
  it("accepts keys under the agent's prefix", () => {
    expect(isAgentKey(AGENT, `${PREFIX}sess-1/full.log`)).toBe(true)
    expect(isAgentKey(AGENT, `${PREFIX}inbox/msg-1/att-image.png`)).toBe(true)
  })

  it("rejects another agent's keys", () => {
    expect(isAgentKey(AGENT, `${agentKeyPrefix(OTHER_AGENT)}victim-sess/full.log`)).toBe(false)
  })

  it('rejects traversal and empty segments', () => {
    expect(isAgentKey(AGENT, `${PREFIX}../${agentKeyPrefix(OTHER_AGENT)}victim-sess/full.log`)).toBe(false)
    expect(isAgentKey(AGENT, `${PREFIX}sess-1//full.log`)).toBe(false)
  })

  it('rejects non-strings', () => {
    expect(isAgentKey(AGENT, undefined)).toBe(false)
    expect(isAgentKey(AGENT, 42)).toBe(false)
  })
})

describe('isAgentUploadKey', () => {
  it("accepts <prefix><own session>/<file>", async () => {
    expect(await isAgentUploadKey(seed() as unknown as D1Database, AGENT, `${PREFIX}sess-1/full.log`)).toBe(true)
  })

  it("rejects a session that belongs to another agent", async () => {
    expect(await isAgentUploadKey(seed() as unknown as D1Database, AGENT, `${PREFIX}victim-sess/full.log`)).toBe(false)
  })

  it('rejects keys that are not exactly three segments', async () => {
    expect(await isAgentUploadKey(seed() as unknown as D1Database, AGENT, `${PREFIX}sess-1/a/full.log`)).toBe(false)
    expect(await isAgentUploadKey(seed() as unknown as D1Database, AGENT, `${PREFIX}inbox/msg-1/x.png`)).toBe(false)
  })
})

describe('messageAttach', () => {
  it("records a key issued to this agent", async () => {
    const db = seed()
    const res = await attach(db, { transcript_key: `${PREFIX}sess-1/full.log` })
    expect(res.status).toBe(200)
    expect(db.messages[0].transcript_key).toBe(`${PREFIX}sess-1/full.log`)
  })

  it("refuses another tenant's transcript key", async () => {
    const db = seed()
    const res = await attach(db, { transcript_key: `${agentKeyPrefix(OTHER_AGENT)}victim-sess/full.log` })
    expect(res.status).toBe(400)
    expect(db.messages[0].transcript_key).toBeNull()
  })

  it("refuses another tenant's image key before reading R2", async () => {
    const res = await attach(seed(), { image_key: `${agentKeyPrefix(OTHER_AGENT)}victim-sess/shot.png`, filename: 'shot.png', mime_type: 'image/png' })
    expect(res.status).toBe(400)
  })
})

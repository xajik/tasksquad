import { describe, it, expect } from 'vitest'
import { resolveRelaySession } from './access.js'
import { daemonOpen } from '../routes/portals.js'
import type { Env, DaemonContext } from '../types.js'

// ── Minimal in-memory D1 fake ─────────────────────────────────────────────────
// Implements just the portal/session lookups resolveRelaySession and daemonOpen issue,
// with the same WHERE semantics, so a portal whose session_id was pointed elsewhere
// is handled exactly as SQLite would handle it.

interface PortalRow { id: string; team_id: string; agent_id: string; status: string; session_id: string | null }
interface SessionRow { id: string; task_id: string; agent_id: string }
interface TaskRow { id: string; team_id: string }

function norm(sql: string) { return sql.replace(/\s+/g, ' ').trim() }

class FakeDB {
  portals: PortalRow[] = []
  sessions: SessionRow[] = []
  tasks: TaskRow[] = []

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

  private first(sql: string, [id]: unknown[]): unknown {
    if (sql === 'SELECT team_id, agent_id FROM portals WHERE id = ? AND session_id = id') {
      const p = this.portals.find(p => p.id === id && p.session_id === p.id)
      return p ? { team_id: p.team_id, agent_id: p.agent_id } : null
    }
    if (sql === 'SELECT t.team_id, s.agent_id FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?') {
      const s = this.sessions.find(s => s.id === id)
      const t = s && this.tasks.find(t => t.id === s.task_id)
      return s && t ? { team_id: t.team_id, agent_id: s.agent_id } : null
    }
    if (sql === "SELECT id, agent_id FROM portals WHERE id = ? AND status = 'pending'") {
      const p = this.portals.find(p => p.id === id && p.status === 'pending')
      return p ? { id: p.id, agent_id: p.agent_id } : null
    }
    throw new Error(`FakeDB: unhandled first() query: ${sql}`)
  }

  private run(sql: string, args: unknown[]): { meta: { changes: number } } {
    if (sql === 'UPDATE portals SET status = ?, session_id = ?, started_at = ? WHERE id = ?') {
      const [status, sessionId, , id] = args as [string, string, number, string]
      const p = this.portals.find(p => p.id === id)
      if (!p) return { meta: { changes: 0 } }
      p.status = status
      p.session_id = sessionId
      return { meta: { changes: 1 } }
    }
    throw new Error(`FakeDB: unhandled run() query: ${sql}`)
  }
}

function makeEnv(db: FakeDB): Env {
  return { DB: db as unknown as D1Database } as unknown as Env
}

function seed(): FakeDB {
  const db = new FakeDB()
  // Victim tenant: a running task session and a running portal.
  db.tasks.push({ id: 'victim-task', team_id: 'victim-team' })
  db.sessions.push({ id: 'victim-session', task_id: 'victim-task', agent_id: 'victim-agent' })
  db.portals.push({ id: 'victim-portal', team_id: 'victim-team', agent_id: 'victim-agent', status: 'running', session_id: 'victim-portal' })
  // Attacker tenant: a pending portal on its own agent.
  db.portals.push({ id: 'attacker-portal', team_id: 'attacker-team', agent_id: 'attacker-agent', status: 'pending', session_id: null })
  return db
}

const ATTACKER: DaemonContext = { teamId: 'attacker-team', agentId: 'attacker-agent', tokenId: '' }

function openRequest(body: unknown): Request {
  return new Request('https://api.example.com/daemon/portal/open', { method: 'POST', body: JSON.stringify(body) })
}

describe('resolveRelaySession', () => {
  it('resolves a task session to its task team and agent', async () => {
    expect(await resolveRelaySession(makeEnv(seed()), 'victim-session'))
      .toEqual({ teamId: 'victim-team', agentId: 'victim-agent' })
  })

  it('resolves a running portal by its own id', async () => {
    expect(await resolveRelaySession(makeEnv(seed()), 'victim-portal'))
      .toEqual({ teamId: 'victim-team', agentId: 'victim-agent' })
  })

  it('does not resolve a pending portal', async () => {
    expect(await resolveRelaySession(makeEnv(seed()), 'attacker-portal')).toBeNull()
  })

  it('ignores a portal whose session_id points at another session', async () => {
    const db = seed()
    // A row written before daemonOpen pinned session_id to the portal id.
    db.portals.push({ id: 'rogue-portal', team_id: 'attacker-team', agent_id: 'attacker-agent', status: 'running', session_id: 'victim-session' })
    expect(await resolveRelaySession(makeEnv(db), 'victim-session'))
      .toEqual({ teamId: 'victim-team', agentId: 'victim-agent' })
  })

  it('refuses an id that is both a portal and a task session', async () => {
    const db = seed()
    db.sessions.push({ id: 'victim-portal', task_id: 'victim-task', agent_id: 'victim-agent' })
    expect(await resolveRelaySession(makeEnv(db), 'victim-portal')).toBeNull()
  })
})

describe('daemonOpen', () => {
  it('pins session_id to the portal id', async () => {
    const db = seed()
    const res = await daemonOpen(openRequest({ portal_id: 'attacker-portal', session_id: 'attacker-portal' }), makeEnv(db), {}, ATTACKER)
    expect(res.status).toBe(200)
    expect(db.portals.find(p => p.id === 'attacker-portal')?.session_id).toBe('attacker-portal')
  })

  it("rejects a session_id other than the portal's own id", async () => {
    const db = seed()
    const res = await daemonOpen(openRequest({ portal_id: 'attacker-portal', session_id: 'victim-session' }), makeEnv(db), {}, ATTACKER)
    expect(res.status).toBe(400)
    expect(db.portals.find(p => p.id === 'attacker-portal')).toMatchObject({ status: 'pending', session_id: null })
    expect(await resolveRelaySession(makeEnv(db), 'victim-session'))
      .toEqual({ teamId: 'victim-team', agentId: 'victim-agent' })
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { claim } from './dream.js'
import type { Env, DaemonContext } from '../types.js'

// ── Minimal in-memory D1 fake ─────────────────────────────────────────────────
// Backs the single INSERT dream.ts issues against dream_runs, including its
// UNIQUE(team_id, project_key, date) constraint (idx_dream_runs_claim,
// 0041_dream_runs.sql) — this is the actual claim mechanism under test, so the
// fake enforces it rather than assuming claim()'s try/catch does the right thing.

function norm(sql: string) { return sql.replace(/\s+/g, ' ').trim() }

interface DreamRunRow { id: string; team_id: string; agent_id: string; project_key: string; date: string; status: string; created_at: number }

class FakeDB {
  dreamRuns: DreamRunRow[] = []

  prepare(sql: string) {
    const s = norm(sql)
    const db = this
    let bound: unknown[] = []
    const api = {
      bind(...args: unknown[]) { bound = args; return api },
      async run() { return db.dispatchRun(s, bound) },
    }
    return api
  }

  private dispatchRun(sql: string, args: unknown[]): { meta: { changes: number } } {
    if (sql === 'INSERT INTO dream_runs (id, team_id, agent_id, project_key, date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)') {
      const [id, teamId, agentId, projectKey, date, status, createdAt] = args as [string, string, string, string, string, string, number]
      if (this.dreamRuns.some(r => r.team_id === teamId && r.project_key === projectKey && r.date === date)) {
        throw new Error('UNIQUE constraint failed: dream_runs.team_id, dream_runs.project_key, dream_runs.date')
      }
      this.dreamRuns.push({ id, team_id: teamId, agent_id: agentId, project_key: projectKey, date, status, created_at: createdAt })
      return { meta: { changes: 1 } }
    }
    throw new Error(`FakeDB: unhandled run() query: ${sql}`)
  }
}

function makeEnv(db: FakeDB): Env {
  return { DB: db as unknown as D1Database } as unknown as Env
}

const DAEMON: DaemonContext = { teamId: 'team-1', agentId: 'agent-1', tokenId: '' }

function claimRequest(body: unknown): Request {
  return new Request('https://api.example.com/daemon/dream/claim', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

let db: FakeDB
beforeEach(() => {
  db = new FakeDB()
})

describe('claim', () => {
  it('claims a project for the first time', async () => {
    const req = claimRequest({ project_key: 'github.com/acme/widgets', date: '2026-07-13' })
    const res = await claim(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(200)
    const body = await res.json() as { claimed: boolean }
    expect(body).toEqual({ claimed: true })
    expect(db.dreamRuns).toHaveLength(1)
    expect(db.dreamRuns[0]).toMatchObject({
      team_id: 'team-1',
      agent_id: 'agent-1',
      project_key: 'github.com/acme/widgets',
      date: '2026-07-13',
      status: 'claimed',
    })
  })

  it('rejects a second claim for the identical (team, project, date) triple, without inserting a second row', async () => {
    const first = await claim(claimRequest({ project_key: 'github.com/acme/widgets', date: '2026-07-13' }), makeEnv(db), {}, DAEMON)
    expect((await first.json() as { claimed: boolean }).claimed).toBe(true)

    const second = await claim(claimRequest({ project_key: 'github.com/acme/widgets', date: '2026-07-13' }), makeEnv(db), {}, { ...DAEMON, agentId: 'agent-2' })
    expect(second.status).toBe(200)
    const body = await second.json() as { claimed: boolean }
    expect(body).toEqual({ claimed: false })
    expect(db.dreamRuns).toHaveLength(1)
  })

  it('allows independent claims for a different date, same team + project', async () => {
    await claim(claimRequest({ project_key: 'github.com/acme/widgets', date: '2026-07-13' }), makeEnv(db), {}, DAEMON)
    const res = await claim(claimRequest({ project_key: 'github.com/acme/widgets', date: '2026-07-14' }), makeEnv(db), {}, DAEMON)
    const body = await res.json() as { claimed: boolean }
    expect(body).toEqual({ claimed: true })
    expect(db.dreamRuns).toHaveLength(2)
  })

  it('allows independent claims for a different project, same team + date', async () => {
    await claim(claimRequest({ project_key: 'github.com/acme/widgets', date: '2026-07-13' }), makeEnv(db), {}, DAEMON)
    const res = await claim(claimRequest({ project_key: 'github.com/acme/gizmos', date: '2026-07-13' }), makeEnv(db), {}, DAEMON)
    const body = await res.json() as { claimed: boolean }
    expect(body).toEqual({ claimed: true })
    expect(db.dreamRuns).toHaveLength(2)
  })

  it('allows the same project_key + date to be claimed independently per team', async () => {
    await claim(claimRequest({ project_key: 'github.com/acme/widgets', date: '2026-07-13' }), makeEnv(db), {}, DAEMON)
    const res = await claim(claimRequest({ project_key: 'github.com/acme/widgets', date: '2026-07-13' }), makeEnv(db), {}, { ...DAEMON, teamId: 'team-2' })
    const body = await res.json() as { claimed: boolean }
    expect(body).toEqual({ claimed: true })
    expect(db.dreamRuns).toHaveLength(2)
  })

  it('rejects a missing project_key', async () => {
    const req = claimRequest({ date: '2026-07-13' })
    const res = await claim(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('missing_fields')
    expect(db.dreamRuns).toHaveLength(0)
  })

  it('rejects a missing date', async () => {
    const req = claimRequest({ project_key: 'github.com/acme/widgets' })
    const res = await claim(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('missing_fields')
  })

  it('rejects a malformed date', async () => {
    const req = claimRequest({ project_key: 'github.com/acme/widgets', date: '07-13-2026' })
    const res = await claim(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_date')
    expect(db.dreamRuns).toHaveLength(0)
  })

  it('rejects an oversized project_key', async () => {
    const req = claimRequest({ project_key: 'x'.repeat(501), date: '2026-07-13' })
    const res = await claim(req, makeEnv(db), {}, DAEMON)
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toBe('invalid_project_key')
    expect(db.dreamRuns).toHaveLength(0)
  })
})

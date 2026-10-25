import { describe, it, expect, vi } from 'vitest'
import type { Env, AuthContext } from '../types.js'

// sessionState authenticates through withFirebaseAuth; stub it to a fixed caller.
vi.mock('../auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.js')>()
  return {
    ...actual,
    withFirebaseAuth: async (): Promise<AuthContext> => ({ uid: 'fb-a', email: 'a@example.com', userId: 'user-a', plan: 'free' }),
  }
})

const { sessionState } = await import('./daemon.js')

// ── Minimal in-memory D1 fake ─────────────────────────────────────────────────
// Evaluates the session-state query: sessions joined to their agent's team, limited
// to teams the caller belongs to.

function norm(sql: string) { return sql.replace(/\s+/g, ' ').trim() }

const SESSIONS = [
  { id: 'own-sess', task_id: 'own-task', agent_id: 'own-agent', status: 'running' },
  { id: 'victim-sess', task_id: 'victim-task', agent_id: 'victim-agent', status: 'running' },
]
const TASKS: Record<string, string> = { 'own-task': 'running', 'victim-task': 'running' }
const AGENT_TEAM: Record<string, string> = { 'own-agent': 'team-a', 'victim-agent': 'team-b' }
const MEMBERS = [{ team_id: 'team-a', user_id: 'user-a' }, { team_id: 'team-b', user_id: 'user-b' }]

const db = {
  prepare(sql: string) {
    const s = norm(sql)
    if (!s.includes('JOIN team_members m ON m.team_id = a.team_id AND m.user_id = ?')) {
      throw new Error(`FakeDB: session state query is not scoped to the caller: ${s}`)
    }
    let args: unknown[] = []
    const api = {
      bind(...a: unknown[]) { args = a; return api },
      async all() {
        const [userId, ...ids] = args
        const results = SESSIONS
          .filter(x => ids.includes(x.id))
          .filter(x => MEMBERS.some(m => m.team_id === AGENT_TEAM[x.agent_id] && m.user_id === userId))
          .map(x => ({ id: x.id, task_id: x.task_id, session_status: x.status, task_status: TASKS[x.task_id] }))
        return { results }
      },
    }
    return api
  },
}

function call(sessions: unknown): Promise<Response> {
  const req = new Request('https://api.example.com/daemon/session/state', { method: 'POST', body: JSON.stringify({ sessions }) })
  return sessionState(req, { DB: db } as unknown as Env, {})
}

describe('sessionState', () => {
  it("returns the caller's own sessions", async () => {
    const res = await call(['own-sess'])
    expect(res.status).toBe(200)
    expect((await res.json() as { states: Record<string, unknown> }).states).toEqual({
      'own-sess': { task_id: 'own-task', task_status: 'running', session_status: 'running' },
    })
  })

  it("omits sessions of agents outside the caller's teams", async () => {
    const res = await call(['own-sess', 'victim-sess'])
    const { states } = await res.json() as { states: Record<string, unknown> }
    expect(Object.keys(states)).toEqual(['own-sess'])
  })

  it('rejects lists over the D1 bind limit and non-string ids', async () => {
    expect((await call(Array.from({ length: 100 }, (_, i) => `s${i}`))).status).toBe(400)
    expect((await call([42])).status).toBe(400)
    expect((await call('own-sess')).status).toBe(400)
  })
})

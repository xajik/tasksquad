import { describe, it, expect } from 'vitest'
import type { Env, DaemonContext } from '../types.js'
import { parseResume, sessionClose } from './daemon.js'

describe('parseResume', () => {
  it('accepts claude, codex, gemini and opencode session ids', () => {
    expect(parseResume('gemini', '6f75c202-a633-4804-8b23-5937aa47f17f')?.provider).toBe('gemini')
    expect(parseResume('opencode', 'ses_f07f24b9affeNBpP0gLeMlv0Zj')?.session_id).toBe('ses_f07f24b9affeNBpP0gLeMlv0Zj')
    expect(parseResume('claude-code', '6f75c202-a633-4804-8b23-5937aa47f17f'))
      .toEqual({ provider: 'claude-code', session_id: '6f75c202-a633-4804-8b23-5937aa47f17f' })
    expect(parseResume('codex', '019a1b2c-3d4e-7f00-8000-000000000000')?.provider).toBe('codex')
  })

  it('rejects unknown providers, missing values and ids that could be read as flags', () => {
    expect(parseResume('claw', 'abc')).toBeNull()
    expect(parseResume('pi', '01a1807b-d4cf-732f-a57d-cc9414b962bd')?.provider).toBe('pi')
    expect(parseResume('claude-code', undefined)).toBeNull()
    expect(parseResume(undefined, 'abc')).toBeNull()
    expect(parseResume('claude-code', '--dangerously-skip-permissions')).toBeNull()
    expect(parseResume('claude-code', 'a b')).toBeNull()
    expect(parseResume('claude-code', 'x'.repeat(200))).toBeNull()
  })
})

// ── sessionClose(status=detached) with a recording D1 fake ────────────────────

function norm(sql: string) { return sql.replace(/\s+/g, ' ').trim() }

function fakeDB(taskStatus: string) {
  const batches: { sql: string; args: unknown[] }[][] = []
  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      const stmt = {
        sql: norm(sql),
        get args() { return args },
        bind(...a: unknown[]) { args = a; return stmt },
        async first() {
          if (stmt.sql.startsWith('SELECT s.task_id, t.status AS task_status FROM sessions s')) {
            return args[0] === 'sess-1' && args[1] === 'agent-1' ? { task_id: 'task-1', task_status: taskStatus } : null
          }
          throw new Error(`FakeDB: unexpected first(): ${stmt.sql}`)
        },
      }
      return stmt
    },
    async batch(stmts: { sql: string; args: unknown[] }[]) {
      batches.push(stmts.map(s => ({ sql: s.sql, args: s.args })))
      return []
    },
  }
  return { db, batches }
}

function detach(db: unknown, body: Record<string, unknown>) {
  const req = new Request('https://api.example.com/daemon/session/close', { method: 'POST', body: JSON.stringify(body) })
  const daemon = { agentId: 'agent-1', teamId: 'team-1' } as unknown as DaemonContext
  return sessionClose(req, { DB: db } as unknown as Env, {}, daemon)
}

describe('sessionClose detached', () => {
  it('keeps the task open, frees the agent and posts no message', async () => {
    const { db, batches } = fakeDB('waiting_input')
    const res = await detach(db, { session_id: 'sess-1', status: 'detached' })
    expect(res.status).toBe(200)
    expect(batches).toHaveLength(1)
    const sqls = batches[0].map(s => s.sql)
    expect(sqls.some(s => s.startsWith('UPDATE sessions SET status = ?'))).toBe(true)
    expect(batches[0].find(s => s.sql.startsWith('UPDATE sessions'))?.args[0]).toBe('detached')
    expect(sqls.some(s => s.startsWith('UPDATE tasks SET status = CASE WHEN EXISTS'))).toBe(true)
    expect(sqls.some(s => s.includes('INSERT INTO messages'))).toBe(false)
    expect(sqls.some(s => s.includes('resume_session_id = NULL'))).toBe(false)
  })

  it('drops the stored provider session when the resume failed', async () => {
    const { db, batches } = fakeDB('running')
    await detach(db, { session_id: 'sess-1', status: 'detached', resume_failed: true })
    expect(batches[0].some(s => s.sql.includes('resume_session_id = NULL'))).toBe(true)
  })

  it('does not reopen a task the user already closed', async () => {
    const { db, batches } = fakeDB('done')
    await detach(db, { session_id: 'sess-1', status: 'detached' })
    expect(batches[0].some(s => s.sql.startsWith('UPDATE tasks SET status'))).toBe(false)
  })

  it('404s for another agent\'s session', async () => {
    const { db } = fakeDB('waiting_input')
    const res = await detach(db, { session_id: 'other', status: 'detached' })
    expect(res.status).toBe(404)
  })
})

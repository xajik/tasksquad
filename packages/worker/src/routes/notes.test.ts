import { describe, it, expect } from 'vitest'
import { listComments, createComment, deleteComment } from './notes.js'
import type { Env, AuthContext } from '../types.js'

// ── Minimal in-memory D1 fake ─────────────────────────────────────────────────
// Two tenants: the attacker is a member of attacker-team only, and the victim's
// note lives in victim-team. Every comment route is called through the attacker's
// own team URL with the victim's note id.

function norm(sql: string) { return sql.replace(/\s+/g, ' ').trim() }

interface Comment { id: string; note_id: string; author_id: string; content: string; created_at: number }

class FakeDB {
  members = [{ team_id: 'attacker-team', user_id: 'attacker' }, { team_id: 'victim-team', user_id: 'victim' }]
  notes = [{ id: 'victim-note', team_id: 'victim-team' }, { id: 'attacker-note', team_id: 'attacker-team' }]
  comments: Comment[] = [{ id: 'victim-comment', note_id: 'victim-note', author_id: 'victim', content: 'secret', created_at: 1 }]

  prepare(sql: string) {
    const s = norm(sql)
    const db = this
    let args: unknown[] = []
    const api = {
      bind(...a: unknown[]) { args = a; return api },
      async first() { return db.first(s, args) },
      async all() { return { results: db.all(s, args) } },
      async run() { return db.run(s, args) },
    }
    return api
  }

  private first(sql: string, args: unknown[]): unknown {
    if (sql === 'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?') {
      const [teamId, userId] = args
      return this.members.some(m => m.team_id === teamId && m.user_id === userId) ? { role: 'member' } : null
    }
    if (sql === 'SELECT 1 FROM notes WHERE id = ? AND team_id = ?') {
      const [id, teamId] = args
      return this.notes.some(n => n.id === id && n.team_id === teamId) ? { 1: 1 } : null
    }
    if (sql === 'SELECT author_id FROM note_comments WHERE id = ? AND note_id = ?') {
      const [id, noteId] = args
      const c = this.comments.find(c => c.id === id && c.note_id === noteId)
      return c ? { author_id: c.author_id } : null
    }
    throw new Error(`FakeDB: unhandled first() query: ${sql}`)
  }

  private all(sql: string, [noteId]: unknown[]): unknown[] {
    if (sql === 'SELECT * FROM note_comments WHERE note_id = ? ORDER BY created_at ASC') {
      return this.comments.filter(c => c.note_id === noteId)
    }
    throw new Error(`FakeDB: unhandled all() query: ${sql}`)
  }

  private run(sql: string, args: unknown[]): { meta: { changes: number } } {
    if (sql === 'INSERT INTO note_comments (id, note_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)') {
      const [id, noteId, authorId, content, createdAt] = args as [string, string, string, string, number]
      this.comments.push({ id, note_id: noteId, author_id: authorId, content, created_at: createdAt })
      return { meta: { changes: 1 } }
    }
    if (sql === 'DELETE FROM note_comments WHERE id = ?') {
      const before = this.comments.length
      this.comments = this.comments.filter(c => c.id !== args[0])
      return { meta: { changes: before - this.comments.length } }
    }
    throw new Error(`FakeDB: unhandled run() query: ${sql}`)
  }
}

function auth(userId: string): AuthContext {
  return { uid: `fb-${userId}`, email: `${userId}@example.com`, userId, plan: 'free' }
}

function env(db: FakeDB): Env {
  return { DB: db as unknown as D1Database } as unknown as Env
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://api.example.com${path}`, init)
}

describe('note comments across teams', () => {
  it("lists a note's comments for members of its team", async () => {
    const res = await listComments(req('/teams/victim-team/notes/victim-note/comments'), env(new FakeDB()), {}, auth('victim'))
    expect(res.status).toBe(200)
    expect((await res.json() as { comments: Comment[] }).comments).toHaveLength(1)
  })

  it("does not list another team's note comments through the caller's own team", async () => {
    const res = await listComments(req('/teams/attacker-team/notes/victim-note/comments'), env(new FakeDB()), {}, auth('attacker'))
    expect(res.status).toBe(404)
  })

  it("does not add comments to another team's note", async () => {
    const db = new FakeDB()
    const res = await createComment(
      req('/teams/attacker-team/notes/victim-note/comments', { method: 'POST', body: JSON.stringify({ content: 'injected' }) }),
      env(db), {}, auth('attacker'),
    )
    expect(res.status).toBe(404)
    expect(db.comments).toHaveLength(1)
  })

  it('adds comments to a note in the caller team', async () => {
    const db = new FakeDB()
    const res = await createComment(
      req('/teams/attacker-team/notes/attacker-note/comments', { method: 'POST', body: JSON.stringify({ content: 'hi' }) }),
      env(db), {}, auth('attacker'),
    )
    expect(res.status).toBe(201)
    expect(db.comments.filter(c => c.note_id === 'attacker-note')).toHaveLength(1)
  })

  it('does not delete a comment through a different note', async () => {
    const db = new FakeDB()
    db.comments.push({ id: 'own-comment', note_id: 'victim-note', author_id: 'victim', content: 'x', created_at: 2 })
    db.notes.push({ id: 'other-note', team_id: 'victim-team' })
    const res = await deleteComment(req('/teams/victim-team/notes/other-note/comments/own-comment', { method: 'DELETE' }), env(db), {}, auth('victim'))
    expect(res.status).toBe(404)
    expect(db.comments.some(c => c.id === 'own-comment')).toBe(true)
  })
})

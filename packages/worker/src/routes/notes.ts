import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'
import { bumpInboxVersion } from '../inbox_version.js'

async function requireMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

// ─── Notes ───────────────────────────────────────────────────────────────────

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2] // /teams/:teamId/notes

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const notes = await env.DB
    .prepare(`
      SELECT n.id, n.team_id, n.author_id, n.title, n.content, n.created_at, n.updated_at,
             json_group_array(t.name) FILTER (WHERE t.name IS NOT NULL) as tags
      FROM notes n
      LEFT JOIN note_tags nt ON n.id = nt.note_id
      LEFT JOIN tags t ON nt.tag_id = t.id
      WHERE n.team_id = ?
      GROUP BY n.id
      ORDER BY n.updated_at DESC
    `)
    .bind(teamId)
    .all()

  // Parse JSON tags
  const results = notes.results.map((n: any) => ({
    ...n,
    tags: JSON.parse(n.tags || '[]')
  }))

  return json({ notes: results })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const teamId = url.pathname.split('/')[2]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const body = await req.json<{ title: string; content: string; tags?: string[] }>()
  const { title, content, tags } = body
  if (!title) return err('missing_fields', 400)

  const id = ulid()
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare('INSERT INTO notes (id, team_id, author_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, teamId, auth.userId, title, content, now, now)
  ])

  if (tags && tags.length > 0) {
    for (const tagName of tags) {
      // Upsert tag
      let tagId = ulid()
      try {
        await env.DB.prepare('INSERT INTO tags (id, team_id, name, created_at) VALUES (?, ?, ?, ?)')
          .bind(tagId, teamId, tagName, now)
          .run()
      } catch (e) {
        // Tag exists, fetch ID
        const existing = await env.DB.prepare('SELECT id FROM tags WHERE team_id = ? AND name = ?').bind(teamId, tagName).first<{ id: string }>()
        if (existing) tagId = existing.id
      }
      // Link
      await env.DB.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').bind(id, tagId).run()
    }
  }

  return json({ id, title, content, created_at: now, updated_at: now, tags: tags || [] }, 201)
}

export async function get(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const noteId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const note = await env.DB
    .prepare(`
      SELECT n.*, json_group_array(t.name) FILTER (WHERE t.name IS NOT NULL) as tags
      FROM notes n
      LEFT JOIN note_tags nt ON n.id = nt.note_id
      LEFT JOIN tags t ON nt.tag_id = t.id
      WHERE n.id = ? AND n.team_id = ?
      GROUP BY n.id
    `)
    .bind(noteId, teamId)
    .first<any>()

  if (!note) return err('not_found', 404)

  note.tags = JSON.parse(note.tags || '[]')
  return json(note)
}

export async function update(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const noteId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const body = await req.json<{ title?: string; content?: string; tags?: string[] }>()
  const now = Date.now()

  const existing = await env.DB.prepare('SELECT id FROM notes WHERE id = ? AND team_id = ?').bind(noteId, teamId).first()
  if (!existing) return err('not_found', 404)

  if (body.title !== undefined || body.content !== undefined || body.tags !== undefined) {
    await env.DB.prepare('UPDATE notes SET title = coalesce(?, title), content = coalesce(?, content), updated_at = ? WHERE id = ?')
      .bind(body.title ?? null, body.content ?? null, now, noteId)
      .run()
  }

  if (body.tags) {
    // Replace tags: delete existing links, insert new
    await env.DB.prepare('DELETE FROM note_tags WHERE note_id = ?').bind(noteId).run()
    
    for (const tagName of body.tags) {
      let tagId = ulid()
      try {
        await env.DB.prepare('INSERT INTO tags (id, team_id, name, created_at) VALUES (?, ?, ?, ?)')
          .bind(tagId, teamId, tagName, now)
          .run()
      } catch {
        const row = await env.DB.prepare('SELECT id FROM tags WHERE team_id = ? AND name = ?').bind(teamId, tagName).first<{ id: string }>()
        if (row) tagId = row.id
      }
      await env.DB.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').bind(noteId, tagId).run()
    }
  }

  return json({ ok: true })
}

export async function remove(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const noteId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  await env.DB.prepare('DELETE FROM notes WHERE id = ? AND team_id = ?').bind(noteId, teamId).run()
  return new Response(null, { status: 204 })
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export async function listComments(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const noteId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const comments = await env.DB
    .prepare('SELECT * FROM note_comments WHERE note_id = ? ORDER BY created_at ASC')
    .bind(noteId)
    .all()

  return json({ comments: comments.results })
}

export async function createComment(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const noteId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const body = await req.json<{ content: string }>()
  if (!body.content) return err('content_required', 400)

  const id = ulid()
  const now = Date.now()

  await env.DB.prepare('INSERT INTO note_comments (id, note_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, noteId, auth.userId, body.content, now)
    .run()

  return json({ id, content: body.content, author_id: auth.userId, created_at: now }, 201)
}

export async function deleteComment(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const commentId = parts[6] // /teams/:teamId/notes/:noteId/comments/:commentId

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const comment = await env.DB.prepare('SELECT author_id FROM note_comments WHERE id = ?').bind(commentId).first<{ author_id: string }>()
  if (!comment) return err('not_found', 404)
  if (comment.author_id !== auth.userId) return err('forbidden', 403)

  await env.DB.prepare('DELETE FROM note_comments WHERE id = ?').bind(commentId).run()
  return new Response(null, { status: 204 })
}

// ─── Convert to Inbox ─────────────────────────────────────────────────────────

export async function convertToInbox(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  const teamId = parts[2]
  const noteId = parts[4]

  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  const note = await env.DB.prepare('SELECT * FROM notes WHERE id = ? AND team_id = ?').bind(noteId, teamId).first<{ title: string; content: string }>()
  if (!note) return err('not_found', 404)

  const body = await req.json<{ agent_id: string; include_comments?: boolean; instructions?: string }>()
  const { agent_id, include_comments, instructions } = body
  if (!agent_id) return err('agent_required', 400)

  // Verify agent belongs to this team
  const agentRow = await env.DB.prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?').bind(agent_id, teamId).first()
  if (!agentRow) return err('agent_not_found', 404)

  let noteContent = note.content
  if (include_comments) {
    const comments = await env.DB.prepare('SELECT content FROM note_comments WHERE note_id = ? ORDER BY created_at ASC').bind(noteId).all<{ content: string }>()
    if (comments.results.length > 0) {
      noteContent += '\n\n---\n**Comments:**\n' + comments.results.map(c => `- ${c.content}`).join('\n')
    }
  }

  // Format the body the agent will receive as its prompt
  const agentBody = [
    `# Note: ${note.title}`,
    '',
    noteContent,
    ...(instructions?.trim() ? ['', '---', `**Instructions:** ${instructions.trim()}`] : []),
  ].join('\n')

  const taskId = ulid()
  const now = Date.now()
  const payload = JSON.stringify({ note_id: noteId, note_title: note.title, instructions: instructions || '' })

  await env.DB.batch([
    // Task
    env.DB.prepare('INSERT INTO tasks (id, team_id, agent_id, sender_id, subject, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(taskId, teamId, agent_id, auth.userId, `Note: ${note.title}`, 'pending', now),
    // System message — portal displays this as a pill showing the conversion event
    env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, type, body, json_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(ulid(), taskId, auth.userId, 'system', 'note-to-inbox', `Note "${note.title}" sent to inbox`, payload, now),
    // User message — this is what the daemon delivers to the agent
    env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, type, body, json_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(ulid(), taskId, auth.userId, 'user', 'note-to-inbox', agentBody, payload, now),
  ])

  await bumpInboxVersion(env, agent_id)

  return json({ task_id: taskId })
}

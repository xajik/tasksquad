import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'
import { importMasterKey, unwrapDEK, decrypt } from '../crypto.js'
import { bumpInboxVersion } from '../inbox_version.js'

async function requireMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare(`
      SELECT m.id, m.task_id, m.sender_id, m.role, m.body, m.type,
             m.json_payload, m.transcript_key, m.created_at, m.scheduled_at,
             pe.interaction_status, pe.interaction_response
      FROM messages m
      LEFT JOIN (
        SELECT pr.id AS msg_id,
               CASE WHEN EXISTS (
                 SELECT 1 FROM messages r
                 WHERE r.task_id = pr.task_id AND r.role = 'user' AND r.created_at > pr.created_at
               ) THEN 'resolved' ELSE 'pending' END AS interaction_status,
               (SELECT r.body FROM messages r
                WHERE r.task_id = pr.task_id AND r.role = 'user' AND r.created_at > pr.created_at
                ORDER BY r.created_at ASC LIMIT 1) AS interaction_response
        FROM messages pr
        WHERE pr.task_id = ? AND pr.type = 'permission_request'
      ) pe ON pe.msg_id = m.id
      WHERE m.task_id = ?
      ORDER BY CASE WHEN m.scheduled_at IS NOT NULL THEN 1 ELSE 0 END ASC, m.created_at ASC
    `)
    .bind(taskId, taskId)
    .all()
  return json({ messages: rows.results })
}

export async function getTranscript(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const parts = new URL(req.url).pathname.split('/')
  const taskId = parts[2]
  const msgId = parts[4]

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  const msg = await env.DB
    .prepare('SELECT transcript_key, agent_id FROM messages m JOIN tasks t ON m.task_id = t.id WHERE m.id = ? AND m.task_id = ?')
    .bind(msgId, taskId)
    .first<{ transcript_key: string | null; agent_id: string }>()
  if (!msg?.transcript_key) return err('not_found', 404)

  const obj = await env.LOGS.get(msg.transcript_key)
  if (!obj) return err('not_found', 404)

  const encrypted = new Uint8Array(await obj.arrayBuffer())
  let plaintext = encrypted

  // If the agent has an encrypted DEK, we assume the log is encrypted
  const agent = await env.DB
    .prepare('SELECT encrypted_dek FROM agents WHERE id = ?')
    .bind(msg.agent_id)
    .first<{ encrypted_dek: string | null }>()
  
  if (agent?.encrypted_dek && env.R2_LOGS_MASTER_KEY) {
    try {
      const masterKey = await importMasterKey(env.R2_LOGS_MASTER_KEY)
      const dek = await unwrapDEK(agent.encrypted_dek, masterKey)
      plaintext = await decrypt(encrypted, dek)
    } catch (e) {
      console.error(`[messages/getTranscript] decryption failed: ${e}`)
      // Fallback to serving raw bytes (might be unencrypted if upload failed or transition)
    }
  }

  const text = new TextDecoder().decode(plaintext)
  return new Response(text, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id, status, agent_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string; status: string; agent_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)
  if (task.status === 'done' || task.status === 'failed') return err('task_closed', 403)

  const body = await req.json<{ body?: string; scheduled_at?: number }>().catch(() => ({} as { body?: string; scheduled_at?: number }))
  const text = body.body?.trim()
  if (!text) return err('body_required', 400)

  const id = ulid()
  const now = Date.now()
  const scheduledAt = body.scheduled_at

  // If scheduled for future, insert with scheduled_at but don't notify agent
  if (scheduledAt && scheduledAt > now) {
    await env.DB
      .prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, taskId, auth.userId, 'user', text, now, scheduledAt)
      .run()
    return json({ id, role: 'user', body: text, created_at: now, scheduled_at: scheduledAt }, 201)
  }

  // Immediate delivery
  await env.DB
    .prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, taskId, auth.userId, 'user', text, now)
    .run()

  // If task was waiting for input, reopen it as pending so daemon picks it up
  if (task.status === 'waiting_input') {
    await env.DB
      .prepare("UPDATE tasks SET status = 'pending', completed_at = NULL WHERE id = ?")
      .bind(taskId)
      .run()
  }

  // Notify the assigned agent that its inbox has a new message.
  await bumpInboxVersion(env, task.agent_id)

  return json({ id, role: 'user', body: text, created_at: now }, 201)
}

export async function update(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const parts = new URL(req.url).pathname.split('/')
  const taskId = parts[2]
  const msgId = parts[4]

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  const msg = await env.DB
    .prepare('SELECT id, sender_id, scheduled_at FROM messages WHERE id = ? AND task_id = ?')
    .bind(msgId, taskId)
    .first<{ id: string; sender_id: string; scheduled_at: number | null }>()
  if (!msg) return err('not_found', 404)

  // Only allow editing scheduled messages that haven't been delivered yet
  if (!msg.scheduled_at || msg.sender_id !== auth.userId) return err('cannot_edit', 403)

  const body = await req.json<{ body?: string; scheduled_at?: number }>().catch(() => ({} as { body?: string; scheduled_at?: number }))
  const text = body.body?.trim()
  const scheduledAt = body.scheduled_at

  if (!text && !scheduledAt) return err('body_required', 400)

  const now = Date.now()
  if (text && scheduledAt && scheduledAt > now) {
    await env.DB
      .prepare('UPDATE messages SET body = ?, scheduled_at = ? WHERE id = ?')
      .bind(text, scheduledAt, msgId)
      .run()
    return json({ id: msgId, body: text, scheduled_at: scheduledAt })
  } else if (text) {
    await env.DB
      .prepare('UPDATE messages SET body = ?, scheduled_at = NULL WHERE id = ?')
      .bind(text, msgId)
      .run()
    return json({ id: msgId, body: text })
  } else if (scheduledAt && scheduledAt > now) {
    await env.DB
      .prepare('UPDATE messages SET scheduled_at = ? WHERE id = ?')
      .bind(scheduledAt, msgId)
      .run()
    return json({ id: msgId, scheduled_at: scheduledAt })
  }

  return err('invalid_schedule', 400)
}

export async function remove(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const parts = new URL(req.url).pathname.split('/')
  const taskId = parts[2]
  const msgId = parts[4]

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  const msg = await env.DB
    .prepare('SELECT id, sender_id, scheduled_at FROM messages WHERE id = ? AND task_id = ?')
    .bind(msgId, taskId)
    .first<{ id: string; sender_id: string; scheduled_at: number | null }>()
  if (!msg) return err('not_found', 404)

  // Only allow deleting scheduled messages that haven't been delivered yet
  if (!msg.scheduled_at || msg.sender_id !== auth.userId) return err('cannot_delete', 403)

  await env.DB
    .prepare('DELETE FROM messages WHERE id = ?')
    .bind(msgId)
    .run()

  return new Response(null, { status: 204 })
}

import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'
import { importMasterKey, unwrapDEK, decrypt } from '../crypto.js'
import { bumpInboxVersion } from '../inbox_version.js'
import { TaskStatus, AgentStatus, SessionStatus, AgentMode, MessageType } from '../statuses.js'
import {
  readMessageAttachment,
  fetchAttachmentsForMessages,
  storeAttachments,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MIME_ALLOWLIST,
} from './helpers.js'

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
             m.json_payload, m.transcript_key, m.created_at, m.scheduled_at, m.grade,
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
        WHERE pr.task_id = ? AND pr.type = ?
      ) pe ON pe.msg_id = m.id
      WHERE m.task_id = ?
      ORDER BY CASE WHEN m.scheduled_at IS NOT NULL THEN 1 ELSE 0 END ASC, m.created_at ASC
    `)
    .bind(taskId, MessageType.PermissionRequest, taskId)
    .all<{ id: string }>()

  const attachmentsByMessage = await fetchAttachmentsForMessages(env, rows.results.map(m => m.id))
  const messages = rows.results.map(m => ({ ...m, attachments: attachmentsByMessage.get(m.id) ?? [] }))

  return json({ messages })
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
    },
  })
}

export async function getMessageAttachment(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const parts = new URL(req.url).pathname.split('/')
  const taskId = parts[2]
  const msgId = parts[4]
  const attachmentId = parts[6]

  const task = await env.DB
    .prepare('SELECT team_id, agent_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string; agent_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  const msg = await env.DB
    .prepare('SELECT id FROM messages WHERE id = ? AND task_id = ?')
    .bind(msgId, taskId)
    .first<{ id: string }>()
  if (!msg) return err('not_found', 404)

  const attachment = await readMessageAttachment(env, attachmentId, msgId, task.agent_id)
  if (!attachment) return err('not_found', 404)

  return new Response(attachment.bytes, {
    headers: {
      'Content-Type': attachment.mimeType,
    },
  })
}

export async function gradeMessage(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const parts = new URL(req.url).pathname.split('/')
  const taskId = parts[2]
  const msgId = parts[4]

  const body = await req.json<{ grade?: number | null }>().catch(() => ({} as { grade?: number | null }))

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  const msg = await env.DB
    .prepare('SELECT id FROM messages WHERE id = ? AND task_id = ?')
    .bind(msgId, taskId)
    .first<{ id: string }>()
  if (!msg) return err('not_found', 404)

  await env.DB
    .prepare('UPDATE messages SET grade = ? WHERE id = ?')
    .bind(body.grade ?? null, msgId)
    .run()

  return json({ ok: true })
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
  if (task.status === TaskStatus.Done || task.status === TaskStatus.Failed) return err('task_closed', 403)

  const contentType = req.headers.get('Content-Type') ?? ''
  let text = ''
  let scheduledAt: number | undefined
  let files: File[] = []

  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData()
    text = ((form.get('body') as string) ?? '').trim()
    const scheduledRaw = form.get('scheduled_at')
    scheduledAt = scheduledRaw ? Number(scheduledRaw) : undefined
    // @cloudflare/workers-types types FormData.getAll() as string[] only, even
    // though the runtime genuinely returns File entries for file fields —
    // go through unknown[] to filter them out safely.
    files = (form.getAll('images') as unknown[]).filter((f): f is File => f instanceof File)
    if (files.length > ATTACHMENT_MAX_PER_MESSAGE) return err('too_many_attachments', 400)
    for (const f of files) {
      if (!ATTACHMENT_MIME_ALLOWLIST.has(f.type)) return err('unsupported_mime_type', 400)
      if (f.size > ATTACHMENT_MAX_BYTES) return err('file_too_large', 400)
    }
  } else {
    const body = await req.json<{ body?: string; scheduled_at?: number }>().catch(() => ({} as { body?: string; scheduled_at?: number }))
    text = body.body?.trim() ?? ''
    scheduledAt = body.scheduled_at
  }

  if (!text) return err('body_required', 400)

  const id = ulid()
  const now = Date.now()

  // If scheduled for future, insert with scheduled_at but don't notify agent
  if (scheduledAt && scheduledAt > now) {
    await env.DB
      .prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, taskId, auth.userId, 'user', text, now, scheduledAt)
      .run()
    const attachments = await storeAttachments(env, task.agent_id, id, files)
    return json({ id, role: 'user', body: text, created_at: now, scheduled_at: scheduledAt, attachments }, 201)
  }

  // Immediate delivery
  await env.DB
    .prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, taskId, auth.userId, 'user', text, now)
    .run()

  const attachments = await storeAttachments(env, task.agent_id, id, files)

  // If task was waiting for input, reopen it as pending so daemon picks it up
  if (task.status === TaskStatus.WaitingInput) {
    await env.DB
      .prepare("UPDATE tasks SET status = ?, completed_at = NULL WHERE id = ?")
      .bind(TaskStatus.Pending, taskId)
      .run()
  }

  // Notify the assigned agent that its inbox has a new message.
  await bumpInboxVersion(env, task.agent_id)

  return json({ id, role: 'user', body: text, created_at: now, attachments }, 201)
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

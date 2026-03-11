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
    .prepare('SELECT id, task_id, sender_id, role, body, transcript_key, created_at FROM messages WHERE task_id = ? ORDER BY created_at ASC')
    .bind(taskId)
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

  const body = await req.json<{ body?: string }>().catch(() => ({} as { body?: string }))
  const text = body.body?.trim()
  if (!text) return err('body_required', 400)

  const id = ulid()
  const now = Date.now()
  await env.DB
    .prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, taskId, auth.userId, 'user', text, now)
    .run()

  // If task was waiting for input or already done/failed, reopen it as pending so daemon picks it up
  if (task.status === 'waiting_input' || task.status === 'done' || task.status === 'failed') {
    await env.DB
      .prepare("UPDATE tasks SET status = 'pending', completed_at = NULL WHERE id = ?")
      .bind(taskId)
      .run()
  }

  // Notify the assigned agent that its inbox has a new message.
  await bumpInboxVersion(env, task.agent_id)

  return json({ id, role: 'user', body: text, created_at: now }, 201)
}

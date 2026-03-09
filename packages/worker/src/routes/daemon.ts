import { ulid } from 'ulidx'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { json, err } from '../auth.js'
import type { Env, DaemonContext } from '../types.js'
import { importMasterKey, unwrapDEK, exportKey } from '../crypto.js'

export async function heartbeat(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{ status?: string }>().catch(() => ({} as { status?: string }))
  const agentId = daemon.agentId
  const agentStatus = body.status ?? 'idle'
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare('UPDATE agents SET status = ?, last_seen = ? WHERE id = ?')
      .bind(agentStatus, now, agentId),
    env.DB.prepare('UPDATE agent_state SET mode = ?, updated_at = ? WHERE agent_id = ?')
      .bind(agentStatus, now, agentId),
  ])

  // When running or waiting for input: check if the task has been cancelled/completed elsewhere.
  if (agentStatus === 'running' || agentStatus === 'waiting_input') {
    const state = await env.DB
      .prepare('SELECT current_task_id FROM agent_state WHERE agent_id = ?')
      .bind(agentId)
      .first<{ current_task_id: string | null }>()

    if (state?.current_task_id) {
      const task = await env.DB
        .prepare('SELECT status FROM tasks WHERE id = ?')
        .bind(state.current_task_id)
        .first<{ status: string }>()

      if (task) {
        // User clicked "Complete session" from the portal while agent is waiting_input:
        // signal a clean shutdown (keep tmux kill in daemon, server already closed session).
        if (task.status === 'done' && agentStatus === 'waiting_input') {
          return json({ ok: true, agent_id: agentId, close: true })
        }
        // Task was cancelled or failed while agent was running — signal cancel.
        if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
          return json({ ok: true, agent_id: agentId, cancel: true })
        }
      }

      if (agentStatus === 'waiting_input') {
        const reply = await env.DB
          .prepare(`
            SELECT body FROM messages
            WHERE task_id = ? AND role = 'user'
              AND created_at > (
                SELECT COALESCE(MAX(created_at), 0) FROM messages
                WHERE task_id = ? AND role = 'agent'
              )
            ORDER BY created_at ASC LIMIT 1
          `)
          .bind(state.current_task_id, state.current_task_id)
          .first<{ body: string }>()

        if (reply) {
          // Resume the agent — set status back to running
          await env.DB.batch([
            env.DB.prepare("UPDATE agents SET status = 'running' WHERE id = ?").bind(agentId),
            env.DB.prepare("UPDATE agent_state SET mode = 'running', updated_at = ? WHERE agent_id = ?").bind(Date.now(), agentId),
            env.DB.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").bind(state.current_task_id),
          ])
          return json({ ok: true, agent_id: agentId, reply: reply.body })
        }
      }
    }
  }

  if (agentStatus === 'idle') {
    const task = await env.DB
      .prepare(`
        SELECT id, subject FROM tasks
        WHERE agent_id = ? AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .bind(agentId)
      .first<{ id: string; subject: string }>()

    if (task) {
      // Return full conversation history so the agent can build context for follow-ups
      const msgRows = await env.DB
        .prepare("SELECT role, body FROM messages WHERE task_id = ? AND role IN ('user', 'agent') ORDER BY created_at ASC")
        .bind(task.id)
        .all<{ role: string; body: string }>()
      return json({ ok: true, agent_id: agentId, task: { id: task.id, subject: task.subject, messages: msgRows.results } })
    }
  }

  return json({ ok: true, agent_id: agentId })
}

export async function sessionOpen(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{ task_id?: string; tmux_session?: string }>().catch(() => ({} as { task_id?: string; tmux_session?: string }))
  const { task_id, tmux_session } = body
  const agentId = daemon.agentId
  if (!task_id) return err('missing_fields', 400)

  const task = await env.DB
    .prepare('SELECT id FROM tasks WHERE id = ? AND team_id = ? AND agent_id = ?')
    .bind(task_id, daemon.teamId, agentId)
    .first<{ id: string }>()
  if (!task) return err('not_found', 404)

  const sessionId = ulid()
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (id, task_id, agent_id, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .bind(sessionId, task_id, agentId, 'running', now),
    env.DB.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?")
      .bind(now, task_id),
    env.DB.prepare('UPDATE agent_state SET current_task_id = ?, current_session = ?, mode = ?, tmux_session = ?, updated_at = ? WHERE agent_id = ?')
      .bind(task_id, sessionId, 'accumulating', tmux_session ?? null, now, agentId),
    env.DB.prepare('UPDATE agents SET status = ? WHERE id = ?')
      .bind('running', agentId),
    // System message
    env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(), task_id, null, 'system', 'Task started.', now),
  ])

  return json({ session_id: sessionId }, 201)
}

export async function sessionClose(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{
    session_id?: string
    status?: string
    final_text?: string
  }>().catch(() => ({} as { session_id?: string; status?: string; final_text?: string }))
  const { session_id, status = 'closed', final_text } = body
  const agentId = daemon.agentId
  if (!session_id) return err('missing_fields', 400)

  const session = await env.DB
    .prepare('SELECT task_id FROM sessions WHERE id = ? AND agent_id = ?')
    .bind(session_id, agentId)
    .first<{ task_id: string }>()
  if (!session) return err('not_found', 404)

  const taskStatus = status === 'closed' ? 'done'
    : status === 'waiting_input' ? 'waiting_input'
    : 'failed'

  const agentStatus = taskStatus === 'waiting_input' ? 'waiting_input' : 'idle'
  const now = Date.now()
  const msgId = ulid()

  const ops = [
    env.DB.prepare('UPDATE sessions SET status = ?, closed_at = ? WHERE id = ?')
      .bind(status, now, session_id),
    env.DB.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
      .bind(taskStatus, now, session.task_id),
    env.DB.prepare('UPDATE agents SET status = ? WHERE id = ?')
      .bind(agentStatus, agentId),
    env.DB.prepare('UPDATE agent_state SET current_task_id = ?, current_session = ?, mode = ?, updated_at = ? WHERE agent_id = ?')
      .bind(null, null, agentStatus === 'idle' ? 'idle' : 'waiting_input', now, agentId),
  ]

  if (final_text) {
    ops.push(
      env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(msgId, session.task_id, null, 'agent', final_text, now)
    )
  }

  await env.DB.batch(ops)

  return json({ ok: true, session_id, message_id: final_text ? msgId : null })
}

export async function complete(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{ session_id?: string; output?: string }>().catch(() => ({} as { session_id?: string; output?: string }))
  const { session_id, output } = body
  const agentId = daemon.agentId
  if (!session_id) return err('missing_fields', 400)

  const session = await env.DB
    .prepare('SELECT task_id FROM sessions WHERE id = ? AND agent_id = ?')
    .bind(session_id, agentId)
    .first<{ task_id: string }>()
  if (!session) return err('not_found', 404)

  const now = Date.now()
  const msgId = ulid()

  const ops = [
    env.DB.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").bind(now, session_id),
    env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").bind(now, session.task_id),
    env.DB.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").bind(agentId),
    env.DB.prepare("UPDATE agent_state SET current_task_id = NULL, current_session = NULL, mode = 'idle', updated_at = ? WHERE agent_id = ?").bind(now, agentId),
  ]

  if (output) {
    ops.push(
      env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(msgId, session.task_id, null, 'agent', output, now)
    )
  }

  await env.DB.batch(ops)

  return json({ ok: true, session_id, message_id: output ? msgId : null })
}

export async function viewers(req: Request, env: Env, _ctx: unknown, _daemon: DaemonContext): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.pathname.split('/')[3]

  // Proxy to the AgentRelay DO which tracks live SSE connections
  const doId = env.AGENT_RELAY.idFromName(agentId)
  const stub = env.AGENT_RELAY.get(doId)
  return stub.fetch(new Request('https://relay/viewers'))
}

export async function push(req: Request, env: Env, _ctx: unknown, _daemon: DaemonContext): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.pathname.split('/')[3]

  const body = await req.json<{ type?: string; lines?: string[] }>().catch(() => ({} as { type?: string; lines?: string[] }))
  if (!body.type || !body.lines) return err('missing_fields', 400)

  // Forward to AgentRelay Durable Object
  const doId = env.AGENT_RELAY.idFromName(agentId)
  const stub = env.AGENT_RELAY.get(doId)
  await stub.fetch(new Request('https://relay/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))

  return json({ ok: true })
}

export async function sessionNotify(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{ session_id?: string; agent_id?: string; message?: string }>()
    .catch(() => ({} as { session_id?: string; agent_id?: string; message?: string }))
  const { session_id, message } = body
  const agentId = daemon.agentId
  if (!session_id || !message) return err('missing_fields', 400)

  const session = await env.DB
    .prepare('SELECT task_id FROM sessions WHERE id = ? AND agent_id = ?')
    .bind(session_id, agentId)
    .first<{ task_id: string }>()
  if (!session) return err('not_found', 404)

  const now = Date.now()
  const msgId = ulid()

  await env.DB.batch([
    env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(msgId, session.task_id, null, 'agent', message, now),
    env.DB.prepare("UPDATE agents SET status = 'waiting_input' WHERE id = ?").bind(agentId),
    env.DB.prepare("UPDATE tasks SET status = 'waiting_input' WHERE id = ?").bind(session.task_id),
    env.DB.prepare("UPDATE agent_state SET mode = 'waiting_input', updated_at = ? WHERE agent_id = ?").bind(now, agentId),
  ])

  return json({ ok: true, session_id, message_id: msgId })
}

export async function presignUpload(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{ session_id: string; filename: string }>().catch(() => ({} as { session_id: string; filename: string }))
  const { session_id, filename } = body
  const agentId = daemon.agentId
  if (!session_id || !filename) return err('missing_fields', 400)

  const session = await env.DB
    .prepare('SELECT id FROM sessions WHERE id = ? AND agent_id = ?')
    .bind(session_id, agentId)
    .first<{ id: string }>()
  if (!session) return err('not_found', 404)

  // Fetch and unwrap the agent's DEK
  let dekB64: string | null = null
  if (env.R2_LOGS_MASTER_KEY) {
    try {
      const agent = await env.DB
        .prepare('SELECT encrypted_dek FROM agents WHERE id = ?')
        .bind(agentId)
        .first<{ encrypted_dek: string | null }>()
      
      if (agent?.encrypted_dek) {
        const masterKey = await importMasterKey(env.R2_LOGS_MASTER_KEY)
        const dek = await unwrapDEK(agent.encrypted_dek, masterKey)
        dekB64 = await exportKey(dek)
      }
    } catch (e) {
      console.error(`[presignUpload] dek unwrap failed: ${e}`)
    }
  }

  const key = `${agentId.substring(0, 16)}/${session_id}/${filename}`

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  })

  let upload_url: string
  try {
    upload_url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: key,
        ContentType: 'application/octet-stream',
      }),
      { expiresIn: 300 }
    )
  } catch (e) {
    console.error(`[presignUpload] failed: ${e}`)
    return err('presign_failed', 500)
  }

  return json({ ok: true, upload_url, key, dek: dekB64 })
}

export async function messageAttach(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const url = new URL(req.url)
  const msgId = url.pathname.split('/')[3]
  const body = await req.json<{ transcript_key?: string }>().catch(() => ({} as { transcript_key?: string }))
  if (!body.transcript_key) return err('missing_key', 400)

  // Verify message belongs to a task in the agent's team
  const msg = await env.DB
    .prepare('SELECT m.id FROM messages m JOIN tasks t ON m.task_id = t.id WHERE m.id = ? AND t.team_id = ?')
    .bind(msgId, daemon.teamId)
    .first()
  if (!msg) return err('not_found', 404)

  await env.DB.prepare('UPDATE messages SET transcript_key = ? WHERE id = ?')
    .bind(body.transcript_key, msgId)
    .run()

  return json({ ok: true })
}

export async function sessionAttach(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const url = new URL(req.url)
  const sessionId = url.pathname.split('/')[3]
  const body = await req.json<{ r2_log_key?: string }>().catch(() => ({} as { r2_log_key?: string }))
  if (!body.r2_log_key) return err('missing_key', 400)

  const session = await env.DB
    .prepare('SELECT id FROM sessions WHERE id = ? AND agent_id = ?')
    .bind(sessionId, daemon.agentId)
    .first()
  if (!session) return err('not_found', 404)

  await env.DB.prepare('UPDATE sessions SET r2_log_key = ? WHERE id = ?')
    .bind(body.r2_log_key, sessionId)
    .run()

  return json({ ok: true })
}

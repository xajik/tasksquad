import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, DaemonContext } from '../types.js'

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

  // When waiting for user input: check if a new user message has arrived since the last agent message.
  if (agentStatus === 'waiting_input') {
    const state = await env.DB
      .prepare('SELECT current_task_id FROM agent_state WHERE agent_id = ?')
      .bind(agentId)
      .first<{ current_task_id: string | null }>()

    if (state?.current_task_id) {
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

    return json({ ok: true, agent_id: agentId })
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
        .bind(ulid(), session.task_id, null, 'agent', final_text, now)
    )
  }

  await env.DB.batch(ops)

  return json({ ok: true })
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
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET status = 'closed', closed_at = ? WHERE id = ?").bind(now, session_id),
    env.DB.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").bind(now, session.task_id),
    env.DB.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").bind(agentId),
    env.DB.prepare("UPDATE agent_state SET current_task_id = NULL, current_session = NULL, mode = 'idle', updated_at = ? WHERE agent_id = ?").bind(now, agentId),
    ...(output ? [env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(), session.task_id, null, 'agent', output, now)] : []),
  ])

  return json({ ok: true })
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

// Called when Claude Code fires a Notification hook — agent is waiting for user input.
// Posts the question as an agent thread message and marks the task/agent as waiting_input.
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
  await env.DB.batch([
    env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(), session.task_id, null, 'agent', message, now),
    env.DB.prepare("UPDATE agents SET status = 'waiting_input' WHERE id = ?").bind(agentId),
    env.DB.prepare("UPDATE tasks SET status = 'waiting_input' WHERE id = ?").bind(session.task_id),
    env.DB.prepare("UPDATE agent_state SET mode = 'waiting_input', updated_at = ? WHERE agent_id = ?").bind(now, agentId),
  ])

  return json({ ok: true })
}

export async function presignUpload(req: Request, env: Env, _ctx: unknown, _daemon: DaemonContext): Promise<Response> {
  const url = new URL(req.url)
  const sessionId = url.searchParams.get('session_id')
  const filename = url.searchParams.get('filename') ?? 'partial.log'
  if (!sessionId) return err('session_id_required', 400)

  const session = await env.DB
    .prepare('SELECT agent_id FROM sessions WHERE id = ?')
    .bind(sessionId)
    .first<{ agent_id: string }>()
  if (!session) return err('not_found', 404)

  const key = `${session.agent_id.substring(0, 16)}/${sessionId}/${filename}`
  // R2 doesn't support presigned URLs directly via Workers binding —
  // return the key and let the daemon upload via the daemon/upload endpoint
  return json({ key })
}

import { ulid } from 'ulidx'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { json, err, withDaemonBatchAuth, withFirebaseAuth } from '../auth.js'
import type { Env, DaemonContext } from '../types.js'
import { importMasterKey, unwrapDEK, exportKey } from '../crypto.js'
import { sendFCMNotification } from '../fcm.js'
import { getCombinedInboxVersion } from '../inbox_version.js'
import { calculateNextRun, type ConveyorRow } from './conveyors.js'

function truncate(text: string, maxLen = 80): string {
  return text.slice(0, maxLen) + (text.length > maxLen ? '…' : '')
}

async function notifyTeamMembers(env: Env, taskId: string, title: string, body: string): Promise<void> {
  try {
    const task = await env.DB
      .prepare('SELECT team_id FROM tasks WHERE id = ?')
      .bind(taskId)
      .first<{ team_id: string | null }>()
    if (!task?.team_id) return

    // Notify all members of the team who have registered push tokens
    const { results: tokens } = await env.DB
      .prepare(`
        SELECT t.token
        FROM push_tokens t
        JOIN team_members m ON m.user_id = t.user_id
        WHERE m.team_id = ?
      `)
      .bind(task.team_id)
      .all<{ token: string }>()
    
    if (!tokens.length) return

    await Promise.all(tokens.map(r =>
      sendFCMNotification(env.FIREBASE_SERVICE_ACCOUNT_KEY, env.FIREBASE_PROJECT_ID, r.token, title, body, taskId)
        .catch(e => console.error('[fcm] token push failed:', e))
    ))
  } catch (e) {
    console.error('[fcm] notifyTeamMembers failed:', e)
  }
}

const HEARTBEAT_MIN_INTERVAL_MS = 45_000
// Base poll interval + up to 5 s of random jitter to spread agent traffic.
const POLL_BASE_MS = 60_000
const POLL_JITTER_MS = 5_000

/** Response with Cache-Control + ETag headers for the polling endpoint. */
function hbJson(data: unknown, version: string, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-cache',
      'ETag': `"${version}"`,
    },
  })
}

/** 304 Not Modified — inbox version unchanged, daemon reuses cached response. */
function hb304(version: string): Response {
  return new Response(null, {
    status: 304,
    headers: {
      'Cache-Control': 'private, no-cache',
      'ETag': `"${version}"`,
    },
  })
}

/** Per-agent heartbeat logic for the batch handler. */
async function processAgentHeartbeat(
  env: Env,
  agentId: string,
  agentStatus: string,
  agentRow: { last_seen: number | null; reset_pending: number; paused: number } | undefined,
  now: number,
  nextPollMs: number
): Promise<Record<string, unknown>> {
  if (agentRow?.reset_pending) {
    await env.DB.batch([
      env.DB.prepare("UPDATE agents SET reset_pending = 0, status = 'offline' WHERE id = ?").bind(agentId),
      env.DB.prepare("UPDATE agent_state SET mode = 'idle', updated_at = ? WHERE agent_id = ?").bind(now, agentId),
    ])
    return { agent_id: agentId, ok: true, reset: true }
  }

  if (agentRow?.paused) {
    return { agent_id: agentId, ok: true, stop_pulling: true }
  }

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
        if (task.status === 'done' && agentStatus === 'waiting_input') {
          return { agent_id: agentId, ok: true, close: true, next_poll_ms: nextPollMs }
        }
        if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
          return { agent_id: agentId, ok: true, cancel: true, next_poll_ms: nextPollMs }
        }
      }

      if (agentStatus === 'waiting_input') {
        const reply = await env.DB
          .prepare(`
            SELECT body FROM messages
            WHERE task_id = ? AND role = 'user'
              AND (scheduled_at IS NULL OR scheduled_at <= ?)
              AND created_at > (
                SELECT COALESCE(MAX(created_at), 0) FROM messages
                WHERE task_id = ? AND role = 'agent'
              )
            ORDER BY created_at ASC LIMIT 1
          `)
          .bind(state.current_task_id, now, state.current_task_id)
          .first<{ body: string }>()

        if (reply) {
          await env.DB.batch([
            env.DB.prepare("UPDATE agents SET status = 'running' WHERE id = ?").bind(agentId),
            env.DB.prepare("UPDATE agent_state SET mode = 'running', updated_at = ? WHERE agent_id = ?").bind(now, agentId),
            env.DB.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").bind(state.current_task_id),
          ])
          return { agent_id: agentId, ok: true, reply: reply.body, next_poll_ms: nextPollMs }
        }
      }
    }

    return { agent_id: agentId, ok: true, next_poll_ms: nextPollMs }
  }

  // Idle: heal any task left in 'running' state by a daemon crash/restart.
  // Reset the stale running task to pending and clear agent_state in one batch.
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE tasks SET status = 'pending', completed_at = NULL
      WHERE id = (SELECT current_task_id FROM agent_state WHERE agent_id = ?)
        AND status = 'running'
    `).bind(agentId),
    env.DB.prepare("UPDATE agent_state SET current_task_id = NULL, current_session = NULL, updated_at = ? WHERE agent_id = ? AND current_task_id IS NOT NULL")
      .bind(now, agentId),
  ])

  // Idle: query for pending task
  const task = await env.DB
    .prepare("SELECT id, subject FROM tasks WHERE agent_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1")
    .bind(agentId)
    .first<{ id: string; subject: string }>()

  if (task) {
    const msgRows = await env.DB
      .prepare("SELECT role, body FROM messages WHERE task_id = ? AND role IN ('user', 'agent') AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY created_at ASC")
      .bind(task.id, now)
      .all<{ role: string; body: string }>()
    return {
      agent_id: agentId,
      ok: true,
      task: { id: task.id, subject: task.subject, messages: msgRows.results },
      next_poll_ms: nextPollMs,
    }
  }

  return { agent_id: agentId, ok: true, next_poll_ms: nextPollMs }
}

async function processConveyors(env: Env, teamIds: string[], now: number) {
  const ONE_HOUR = 3600_000

  // Fast-path: check KV to skip teams processed in the last hour (avoids a D1 read per heartbeat)
  const kvValues = await Promise.all(teamIds.map(id => env.POLL_CACHE.get(`cv:lr:${id}`)))
  const dueTeams = teamIds.filter((_, i) => {
    const v = kvValues[i]
    return v === null || now - parseInt(v) >= ONE_HOUR
  })
  if (!dueTeams.length) return

  for (const teamId of dueTeams) {
    // Find conveyors due within the next hour
    const { results: dueConveyors } = await env.DB
      .prepare(`
        SELECT * FROM conveyors
        WHERE team_id = ?
          AND next_run_at <= ?
          AND (repeat_count IS NULL OR repeat_counter < repeat_count)
          AND (end_date IS NULL OR next_run_at <= end_date)
      `)
      .bind(teamId, now + ONE_HOUR)
      .all<ConveyorRow>()

    for (const conveyor of dueConveyors) {
      const taskId = ulid()
      const msgId = ulid()

      const nextRun = calculateNextRun(
        conveyor.next_run_at,
        conveyor.frequency,
        conveyor.day_of_week,
        conveyor.day_of_month,
        conveyor.hour,
        conveyor.minute ?? 0,
        conveyor.timezone ?? 'UTC'
      )

      await env.DB.batch([
        env.DB.prepare('INSERT INTO tasks (id, team_id, agent_id, sender_id, subject, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(taskId, teamId, conveyor.agent_id, conveyor.sender_id, conveyor.subject, 'scheduled', now),
        env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(msgId, taskId, conveyor.sender_id, 'user', conveyor.body, now, conveyor.next_run_at),
        env.DB.prepare('UPDATE conveyors SET repeat_counter = repeat_counter + 1, next_run_at = ? WHERE id = ?')
          .bind(nextRun, conveyor.id),
      ])
    }

    // Persist last-run timestamp: KV for fast heartbeat skipping, D1 for durability
    await Promise.all([
      env.POLL_CACHE.put(`cv:lr:${teamId}`, String(now), { expirationTtl: 7200 }),
      env.DB.prepare('UPDATE teams SET last_conveyor_run = ? WHERE id = ?').bind(now, teamId).run(),
    ])
  }
}

/**
 * POST /daemon/heartbeat/batch
 *
 * Single request carrying all agent tokens + statuses for a daemon process.
 * Returns per-agent responses; uses a combined ETag so a 304 can short-circuit
 * the entire batch when all agents are idle and nothing has changed.
 */
export async function batchHeartbeat(req: Request, env: Env, _ctx: unknown): Promise<Response> {
  const body = await req
    .json<{ agents?: Array<{ id: string; status: string }> }>()
    .catch(() => ({} as { agents?: Array<{ id: string; status: string }> }))

  const agentEntries = body.agents
  if (!agentEntries?.length) return err('missing_fields', 400)

  const agentIds = agentEntries.map(e => e.id)
  const statuses = agentEntries.map(e => e.status ?? 'idle')

  // Authenticate via Firebase token; verify all agent IDs belong to the user.
  const authResult = await withDaemonBatchAuth(req, agentIds, env)
  if (authResult instanceof Response) return authResult

  const now = Date.now()
  const nextPollMs = POLL_BASE_MS + Math.floor(Math.random() * POLL_JITTER_MS)

  // Run conveyor check once per hour per team
  const teamsToCheck = [...new Set(authResult.map(c => c.teamId))]
  await processConveyors(env, teamsToCheck, now)

  // Deliver any scheduled messages that are now due for this batch of agents.
  // Doing this before processing means the daemon picks up delivered tasks in
  // the same request — no extra round-trip needed.
  const placeholders = agentIds.map(() => '?').join(',')
  const dueMessages = await env.DB
    .prepare(`
      SELECT m.id, m.task_id, t.agent_id, t.status AS task_status
      FROM messages m
      JOIN tasks t ON m.task_id = t.id
      WHERE m.scheduled_at IS NOT NULL
        AND m.scheduled_at <= ?
        AND m.role = 'user'
        AND t.agent_id IN (${placeholders})
    `)
    .bind(now, ...agentIds)
    .all<{ id: string; task_id: string; agent_id: string; task_status: string }>()

  for (const msg of dueMessages.results) {
    const agentIdx = agentIds.indexOf(msg.agent_id)
    const agentCurrentStatus = agentIdx >= 0 ? statuses[agentIdx] : 'idle'

    // If the agent is mid-run on this exact task, leave the message scheduled so it
    // is not lost.  It will be picked up on the next heartbeat after the agent
    // finishes or transitions to waiting_input.
    if (agentCurrentStatus === 'running' && msg.task_status === 'running') {
      continue
    }

    // Don't deliver to terminal tasks — message stays in DB undelivered.
    if (msg.task_status === 'done' || msg.task_status === 'failed') {
      continue
    }

    await env.DB
      .prepare('UPDATE messages SET scheduled_at = NULL WHERE id = ?')
      .bind(msg.id)
      .run()

    // Reset task to pending so the agent picks it up on the next heartbeat.
    // Skip if already pending (no-op), or if the agent is in waiting_input —
    // in that case the reply-detection query will find the message directly.
    if (msg.task_status !== 'pending' && msg.task_status !== 'running') {
      await env.DB
        .prepare("UPDATE tasks SET status = 'pending', completed_at = NULL WHERE id = ?")
        .bind(msg.task_id)
        .run()
    }
  }

  const allIdle = statuses.every(s => s === 'idle')

  // Fetch agent rows for rate-limit check + control flags (single D1 batch)
  const agentRowResults = await env.DB.batch(
    agentIds.map(id =>
      env.DB.prepare('SELECT last_seen, reset_pending, paused FROM agents WHERE id = ?').bind(id)
    )
  )
  const agentRows = agentRowResults.map(
    r => r.results[0] as { last_seen: number | null; reset_pending: number; paused: number } | undefined
  )

  // Enforce per-agent rate limit; reject the whole batch if any agent fires too fast
  for (let i = 0; i < agentIds.length; i++) {
    const row = agentRows[i]
    if (row?.last_seen != null && now - row.last_seen < HEARTBEAT_MIN_INTERVAL_MS) {
      return err('too_many_requests', 429)
    }
  }

  // Update status + last_seen for all agents in one batch write
  await env.DB.batch(
    agentIds.flatMap((id, i) => [
      env.DB.prepare('UPDATE agents SET status = ?, last_seen = ? WHERE id = ?').bind(statuses[i], now, id),
      env.DB.prepare('UPDATE agent_state SET mode = ?, updated_at = ? WHERE agent_id = ?').bind(statuses[i], now, id),
    ])
  )

  // Combined ETag short-circuit — only valid when ALL agents are idle
  let combinedVersion: string | undefined
  if (allIdle) {
    combinedVersion = await getCombinedInboxVersion(env, agentIds)
    const clientEtag = req.headers.get('If-None-Match')
    if (clientEtag === `"${combinedVersion}"`) {
      return hb304(combinedVersion)
    }
  }

  // Process each agent independently (in parallel)
  const agentResponses = await Promise.all(
    agentIds.map((agentId, i) =>
      processAgentHeartbeat(env, agentId, statuses[i], agentRows[i], now, nextPollMs)
    )
  )

  if (!combinedVersion) {
    combinedVersion = await getCombinedInboxVersion(env, agentIds)
  }

  return hbJson({ agents: agentResponses }, combinedVersion)
}

export async function sessionOpen(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{ task_id?: string; tmux_session?: string }>().catch(() => ({} as { task_id?: string; tmux_session?: string }))
  const { task_id, tmux_session } = body
  const agentId = daemon.agentId
  if (!task_id) return err('missing_fields', 400)

  const task = await env.DB
    .prepare('SELECT t.id, t.subject, t.started_at, a.name as agent_name FROM tasks t JOIN agents a ON a.id = t.agent_id WHERE t.id = ? AND t.team_id = ? AND t.agent_id = ?')
    .bind(task_id, daemon.teamId, agentId)
    .first<{ id: string; subject: string; started_at: number | null; agent_name: string }>()
  if (!task) return err('not_found', 404)

  const sessionId = ulid()
  const now = Date.now()

  const openOps: D1PreparedStatement[] = [
    env.DB.prepare('INSERT INTO sessions (id, task_id, agent_id, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .bind(sessionId, task_id, agentId, 'running', now),
    env.DB.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?")
      .bind(now, task_id),
    env.DB.prepare('UPDATE agent_state SET current_task_id = ?, current_session = ?, mode = ?, tmux_session = ?, updated_at = ? WHERE agent_id = ?')
      .bind(task_id, sessionId, 'accumulating', tmux_session ?? null, now, agentId),
    env.DB.prepare('UPDATE agents SET status = ? WHERE id = ?')
      .bind('running', agentId),
  ]
  // Only insert "Task started." on the first session — not on re-opens triggered by
  // scheduled messages (which create a second session for the same task).
  if (!task.started_at) {
    openOps.push(
      env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(ulid(), task_id, null, 'system', 'Task started.', now)
    )
  }

  await env.DB.batch(openOps)

  await notifyTeamMembers(env, task_id, `${task.agent_name} picked up a task`, task.subject)
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
    .prepare('SELECT s.task_id, t.subject, a.name as agent_name FROM sessions s JOIN tasks t ON t.id = s.task_id JOIN agents a ON a.id = s.agent_id WHERE s.id = ? AND s.agent_id = ?')
    .bind(session_id, agentId)
    .first<{ task_id: string; subject: string; agent_name: string }>()
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

  const agentName = session.agent_name ?? 'Agent'
  const notifTitle = taskStatus === 'done' ? `${agentName} completed a task`
    : taskStatus === 'waiting_input' ? `${agentName} needs your input`
    : `${agentName} failed`
  const notifBody = taskStatus === 'waiting_input' && final_text
    ? `${session.subject} · ${truncate(final_text)}`
    : session.subject
  await notifyTeamMembers(env, session.task_id, notifTitle, notifBody)

  return json({ ok: true, session_id, message_id: final_text ? msgId : null })
}

export async function complete(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{ session_id?: string; output?: string }>().catch(() => ({} as { session_id?: string; output?: string }))
  const { session_id, output } = body
  const agentId = daemon.agentId
  if (!session_id) return err('missing_fields', 400)

  const session = await env.DB
    .prepare('SELECT s.task_id, t.subject FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ? AND s.agent_id = ?')
    .bind(session_id, agentId)
    .first<{ task_id: string; subject: string }>()
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

  await notifyTeamMembers(env, session.task_id, 'Task completed', `Completed: ${session.subject}`)

  return json({ ok: true, session_id, message_id: output ? msgId : null })
}

export async function viewers(_req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const agentId = daemon.agentId

  // Proxy to the AgentRelay DO which tracks live SSE connections
  const doId = env.AGENT_RELAY.idFromName(agentId)
  const stub = env.AGENT_RELAY.get(doId)
  return stub.fetch(new Request('https://relay/viewers'))
}

export async function push(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const agentId = daemon.agentId

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
    .prepare('SELECT s.task_id, t.subject, a.name as agent_name FROM sessions s JOIN tasks t ON t.id = s.task_id JOIN agents a ON a.id = s.agent_id WHERE s.id = ? AND s.agent_id = ?')
    .bind(session_id, agentId)
    .first<{ task_id: string; subject: string; agent_name: string }>()
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

  const agentName = session.agent_name ?? 'Agent'
  await notifyTeamMembers(env, session.task_id, `${agentName} needs your input`, `${session.subject} · ${truncate(message)}`)

  return json({ ok: true, session_id, message_id: msgId })
}

/**
 * POST /daemon/session/message
 *
 * Post an intermediate agent message to the thread without changing task status.
 * Used for: thinking, tool_call, tool_result, output.
 * Only sessionNotify (type=final) transitions the task to waiting_input.
 */
export async function sessionMessage(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{
    session_id?: string
    type?: 'thinking' | 'tool_call' | 'tool_result' | 'output'
    message?: string
  }>().catch(() => ({} as { session_id?: string; type?: 'thinking' | 'tool_call' | 'tool_result' | 'output'; message?: string }))

  const { session_id, type, message } = body
  const agentId = daemon.agentId
  if (!session_id || !message) return err('missing_fields', 400)

  const VALID_TYPES = ['thinking', 'tool_call', 'tool_result', 'output'] as const
  if (type && !VALID_TYPES.includes(type)) return err('invalid_type', 400)

  const session = await env.DB
    .prepare('SELECT s.task_id FROM sessions s WHERE s.id = ? AND s.agent_id = ?')
    .bind(session_id, agentId)
    .first<{ task_id: string }>()
  if (!session) return err('not_found', 404)

  const msgId = ulid()
  const now = Date.now()

  await env.DB
    .prepare('INSERT INTO messages (id, task_id, sender_id, role, body, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(msgId, session.task_id, null, 'agent', message, type ?? null, now)
    .run()

  return json({ ok: true, message_id: msgId }, 201)
}

export async function presignUpload(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{ session_id: string; filename: string }>().catch(() => ({} as { session_id: string; filename: string }))
  const { session_id, filename } = body
  const agentId = daemon.agentId
  if (!session_id || !filename) return err('missing_fields', 400)

  const session = await env.DB
    .prepare('SELECT s.id FROM sessions s JOIN agents a ON s.agent_id = a.id WHERE s.id = ? AND a.id = ? AND a.team_id = ?')
    .bind(session_id, agentId, daemon.teamId)
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

  // Verify message belongs to a task assigned to this agent (within the agent's team)
  const msg = await env.DB
    .prepare('SELECT m.id FROM messages m JOIN tasks t ON m.task_id = t.id WHERE m.id = ? AND t.team_id = ? AND t.agent_id = ?')
    .bind(msgId, daemon.teamId, daemon.agentId)
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
    .prepare('SELECT s.id FROM sessions s JOIN agents a ON s.agent_id = a.id WHERE s.id = ? AND a.id = ? AND a.team_id = ?')
    .bind(sessionId, daemon.agentId, daemon.teamId)
    .first()
  if (!session) return err('not_found', 404)

  await env.DB.prepare('UPDATE sessions SET r2_log_key = ? WHERE id = ?')
    .bind(body.r2_log_key, sessionId)
    .run()

  return json({ ok: true })
}

/**
 * POST /daemon/permission/request
 *
 * Called by the daemon hook script when Claude Code fires a PermissionRequest event.
 * Creates a permission_request message in the task thread and transitions the task to
 * waiting_input so the portal user can reply. The existing batch heartbeat delivers
 * the reply back to the daemon (no new polling mechanism needed).
 */
export async function permissionRequest(req: Request, env: Env, _ctx: unknown, daemon: DaemonContext): Promise<Response> {
  const body = await req.json<{
    session_id?: string
    tool_name?: string
    tool_input?: unknown
    options?: string[]
  }>().catch(() => ({} as { session_id?: string; tool_name?: string; tool_input?: unknown; options?: string[] }))

  const { session_id, tool_name, tool_input, options } = body
  const agentId = daemon.agentId
  if (!session_id || !tool_name || tool_input === undefined) return err('missing_fields', 400)

  const session = await env.DB
    .prepare('SELECT s.task_id, t.subject, a.name AS agent_name FROM sessions s JOIN tasks t ON t.id = s.task_id JOIN agents a ON a.id = s.agent_id WHERE s.id = ? AND s.agent_id = ?')
    .bind(session_id, agentId)
    .first<{ task_id: string; subject: string; agent_name: string }>()
  if (!session) return err('not_found', 404)

  const optionsArr = Array.isArray(options) ? options.filter(o => typeof o === 'string') : []
  const payload: Record<string, unknown> = { tool_name, tool_input }
  if (optionsArr.length) payload.options = optionsArr
  const jsonPayload = JSON.stringify(payload)

  const msgId = ulid()
  const now = Date.now()
  const agentName = session.agent_name ?? 'Agent'
  const msgBody = `${agentName} needs permission to run ${tool_name}`

  await env.DB.batch([
    env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, type, json_payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(msgId, session.task_id, null, 'agent', msgBody, 'permission_request', jsonPayload, now),
    env.DB.prepare("UPDATE tasks SET status = 'waiting_input' WHERE id = ?").bind(session.task_id),
    env.DB.prepare("UPDATE agents SET status = 'waiting_input' WHERE id = ?").bind(agentId),
    env.DB.prepare("UPDATE agent_state SET mode = 'waiting_input', updated_at = ? WHERE agent_id = ?").bind(now, agentId),
  ])

  await notifyTeamMembers(env, session.task_id, `${agentName} needs permission`, `${session.subject} · ${tool_name}`)

  return json({ id: msgId }, 201)
}

/**
 * GET /daemon/user/agents
 *
 * Returns all teams and their agents for the authenticated user.
 * Used by `tsq init` to discover which agents to configure on the machine.
 */
export async function userAgents(req: Request, env: Env, _ctx: unknown): Promise<Response> {
  const firebaseResult = await withFirebaseAuth(req, env)
  if (firebaseResult instanceof Response) return firebaseResult

  const { results: agents } = await env.DB
    .prepare(`
      SELECT a.id, a.name, a.team_id, t.name AS team_name
      FROM agents a
      JOIN teams t ON t.id = a.team_id
      JOIN team_members m ON m.team_id = a.team_id
      WHERE m.user_id = ?
      ORDER BY t.name, a.name
    `)
    .bind(firebaseResult.userId)
    .all<{ id: string; name: string; team_id: string; team_name: string }>()

  return json({ agents })
}


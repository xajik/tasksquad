import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'
import { bumpInboxVersion } from '../inbox_version.js'
import { TaskStatus, AgentStatus, SessionStatus, AgentMode } from '../statuses.js'

async function requireMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.searchParams.get('agent_id')
  const status = url.searchParams.get('status')
  const teamId = url.searchParams.get('team_id')

  // Determine which team to scope to — require team_id query param for now
  if (!teamId) return err('team_id_required', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  let query = `
    SELECT t.id, t.team_id, t.agent_id, t.sender_id, t.subject, t.status, t.created_at, t.started_at, t.completed_at,
           m.role as first_message_role, m.type as first_message_type,
           MAX(all_m.scheduled_at) as scheduled_at
    FROM tasks t
    LEFT JOIN messages m ON m.task_id = t.id AND m.id = (
      SELECT id FROM messages WHERE task_id = t.id ORDER BY created_at ASC, id ASC LIMIT 1
    )
    LEFT JOIN messages all_m ON all_m.task_id = t.id
    WHERE t.team_id = ?
  `
  const binds: unknown[] = [teamId]

  if (agentId) { query += ' AND t.agent_id = ?'; binds.push(agentId) }
  if (status)  { query += ' AND t.status = ?';   binds.push(status) }
  query += ' GROUP BY t.id ORDER BY t.created_at DESC LIMIT 100'

  const rows = await env.DB.prepare(query).bind(...binds).all()
  return json({ tasks: rows.results })
}

export async function get(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT id, team_id, agent_id, sender_id, subject, status, created_at, started_at, completed_at, settings, close_steps, close_steps_active_idx FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ id: string; team_id: string; agent_id: string; sender_id: string; subject: string; status: string; created_at: number; started_at: number | null; completed_at: number | null; settings: string | null; close_steps: string | null; close_steps_active_idx: number }>()

  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  let closeSteps: string[] | null = null
  try { closeSteps = task.close_steps ? JSON.parse(task.close_steps) : null } catch { closeSteps = null }

  return json({ ...task, settings: task.settings ? JSON.parse(task.settings) : null, close_steps: closeSteps })
}

export async function updateSettings(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const body = await req.json<{ save_tokens?: { enabled: boolean; level: string } }>().catch(() => ({} as { save_tokens?: { enabled: boolean; level: string } }))

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  await env.DB
    .prepare('UPDATE tasks SET settings = ? WHERE id = ?')
    .bind(JSON.stringify(body), taskId)
    .run()

  return json({ ok: true })
}

export async function update(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]
  const body = await req.json<{ status?: string }>().catch(() => ({} as { status?: string }))

  if (!body.status) return err('status_required', 400)

  const task = await env.DB
    .prepare('SELECT team_id, status FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string; status: string }>()

  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  const now = Date.now()
  await env.DB.prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?')
    .bind(body.status, body.status === TaskStatus.Done || body.status === TaskStatus.Failed ? now : null, taskId)
    .run()

  return json({ ok: true })
}

export async function create(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const body = await req.json<{ agent_id?: string; subject?: string; team_id?: string; body?: string; scheduled_at?: number; auto_close?: boolean; save_tokens?: { enabled: boolean; level: string }; close_steps?: string[] }>().catch(() => ({} as { agent_id?: string; subject?: string; team_id?: string; body?: string; scheduled_at?: number; auto_close?: boolean; save_tokens?: { enabled: boolean; level: string }; close_steps?: string[] }))
  const { agent_id, subject, team_id, body: taskBody, scheduled_at, auto_close, save_tokens, close_steps } = body
  if (!agent_id || !subject?.trim() || !team_id) return err('missing_fields', 400)

  if (!(await requireMember(env.DB, team_id, auth.userId))) return err('forbidden', 403)

  const hourAgo = Date.now() - 3_600_000
  const recentCount = await env.DB
    .prepare('SELECT COUNT(*) as n FROM tasks WHERE sender_id = ? AND created_at > ?')
    .bind(auth.userId, hourAgo)
    .first<{ n: number }>()
  if ((recentCount?.n ?? 0) >= 20) return err('rate_limit_exceeded', 429)

  // Verify agent belongs to team
  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(agent_id, team_id)
    .first<{ id: string }>()
  if (!agent) return err('agent_not_found', 404)

  const taskId = ulid()
  const now = Date.now()
  const isScheduled = scheduled_at && scheduled_at > now

  const autoCloseVal = auto_close ? 1 : 0
  const settingsVal = save_tokens ? JSON.stringify({ save_tokens }) : null
  const closeStepsVal = close_steps?.length ? JSON.stringify(close_steps) : null

  if (isScheduled) {
    await env.DB.batch([
      // Use 'scheduled' status so the daemon doesn't pick it up before the scheduled time
      env.DB.prepare('INSERT INTO tasks (id, team_id, agent_id, sender_id, subject, status, created_at, auto_close, settings, close_steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(taskId, team_id, agent_id, auth.userId, subject.trim(), TaskStatus.Scheduled, now, autoCloseVal, settingsVal, closeStepsVal),
      // Insert initial user message with scheduled_at
      env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(ulid(), taskId, auth.userId, 'user', taskBody?.trim() || subject.trim(), now, scheduled_at),
    ])
    return json({ id: taskId, status: TaskStatus.Scheduled }, 201)
  }

  await env.DB.batch([
    env.DB.prepare('INSERT INTO tasks (id, team_id, agent_id, sender_id, subject, status, created_at, auto_close, settings, close_steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(taskId, team_id, agent_id, auth.userId, subject.trim(), TaskStatus.Pending, now, autoCloseVal, settingsVal, closeStepsVal),
    // Insert initial user message — use body if provided, else fall back to subject
    env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(), taskId, auth.userId, 'user', taskBody?.trim() || subject.trim(), now),
  ])

  await bumpInboxVersion(env, agent_id)

  return json({ id: taskId, status: TaskStatus.Pending }, 201)
}

export async function closeTask(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id, agent_id, close_steps FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string; agent_id: string; close_steps: string | null }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  const now = Date.now()

  const agent = await env.DB.prepare("SELECT status FROM agents WHERE id = ?")
    .bind(task.agent_id).first<{ status: string }>()

  // If the agent is waiting_input and the task has close_steps, start the close sequence.
  if (agent?.status === AgentStatus.WaitingInput && task.close_steps) {
    await env.DB.prepare("UPDATE tasks SET status = ? WHERE id = ?").bind(TaskStatus.WrappingUp, taskId).run()
    return json({ ok: true })
  }

  // No close_steps or agent not in waiting_input — close immediately.
  const session = await env.DB
    .prepare("SELECT id FROM sessions WHERE task_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1")
    .bind(taskId, SessionStatus.Running)
    .first<{ id: string }>()

  const ops = [
    env.DB.prepare("UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?").bind(TaskStatus.Done, now, taskId),
  ]
  if (session) {
    ops.push(
      env.DB.prepare("UPDATE sessions SET status = ?, closed_at = ? WHERE id = ?").bind(SessionStatus.Closed, now, session.id)
    )
  }

  await env.DB.batch(ops)
  return json({ ok: true })
}

export async function deleteTask(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id, agent_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string; agent_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  const now = Date.now()

  // Complete any active session so the daemon receives a cancel signal on next heartbeat
  const activeSession = await env.DB
    .prepare("SELECT id FROM sessions WHERE task_id = ? AND status IN (?, ?) ORDER BY started_at DESC LIMIT 1")
    .bind(taskId, SessionStatus.Running, SessionStatus.WaitingInput)
    .first<{ id: string }>()

  await env.DB.batch([
    // Close active session and reset agent state before deleting
    ...(activeSession ? [
      env.DB.prepare("UPDATE sessions SET status = ?, closed_at = ? WHERE id = ?").bind(SessionStatus.Closed, now, activeSession.id),
      env.DB.prepare("UPDATE agents SET status = ? WHERE id = ?").bind(AgentStatus.Idle, task.agent_id),
      env.DB.prepare("UPDATE agent_state SET current_task_id = NULL, current_session = NULL, mode = ?, updated_at = ? WHERE agent_id = ?").bind(AgentMode.Idle, now, task.agent_id),
    ] : [
      // No active session — still clear any stale FK refs
      env.DB.prepare('UPDATE agent_state SET current_task_id = NULL, current_session = NULL WHERE current_task_id = ?').bind(taskId),
    ]),
    env.DB.prepare('DELETE FROM task_logs WHERE task_id = ?').bind(taskId),
    env.DB.prepare('DELETE FROM messages WHERE task_id = ?').bind(taskId),
    env.DB.prepare('DELETE FROM sessions WHERE task_id = ?').bind(taskId),
    env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(taskId),
  ])
  return json({ ok: true })
}

export async function forwardTask(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const body = await req.json<{ agent_id?: string; instructions?: string }>().catch(() => ({} as { agent_id?: string; instructions?: string }))
  if (!body.agent_id) return err('agent_id_required', 400)

  const task = await env.DB
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ id: string; team_id: string; agent_id: string; subject: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  // Verify target agent belongs to the same team
  const agent = await env.DB
    .prepare('SELECT id FROM agents WHERE id = ? AND team_id = ?')
    .bind(body.agent_id, task.team_id)
    .first<{ id: string }>()
  if (!agent) return err('agent_not_found', 404)

  const { results: msgs } = await env.DB
    .prepare(`
      SELECT m.role, m.body
      FROM messages m
      WHERE m.task_id = ? ORDER BY m.created_at ASC
    `)
    .bind(taskId)
    .all<{ role: string; body: string }>()

  const history = msgs.map(m => {
    const label = m.role === 'user' ? 'User' : 'Agent'
    return `[${label}]: ${m.body}`
  }).join('\n\n---\n\n')

  let messageBody = `[Forwarded thread]\n\n${history}`
  if (body.instructions?.trim()) {
    messageBody = `${body.instructions.trim()}\n\n---\n\n${messageBody}`
  }

  const newId = ulid()
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO tasks (id, team_id, agent_id, sender_id, subject, status, created_at, parent_task_id) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(newId, task.team_id, body.agent_id, auth.userId, task.subject, TaskStatus.Pending, now, taskId),
    env.DB.prepare(
      'INSERT INTO messages (id, task_id, sender_id, role, body, created_at) VALUES (?,?,?,?,?,?)'
    ).bind(ulid(), newId, auth.userId, 'user', messageBody, now),
  ])

  await bumpInboxVersion(env, body.agent_id)

  return json({ task_id: newId }, 201)
}

export async function logs(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  const rows = await env.DB
    .prepare('SELECT id, level, body, created_at FROM task_logs WHERE task_id = ? ORDER BY created_at ASC')
    .bind(taskId)
    .all()
  return json({ logs: rows.results })
}

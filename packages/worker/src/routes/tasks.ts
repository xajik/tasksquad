import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'
import { bumpInboxVersion } from '../inbox_version.js'
import { TaskStatus, AgentStatus, SessionStatus, AgentMode, MessageType } from '../statuses.js'
import { onTaskDone, makePlannerEngine } from '../planner/hook.js'
import type { VerdictSource } from '../planner/types.js'
import { storeAttachments, ATTACHMENT_MAX_PER_MESSAGE, ATTACHMENT_MAX_BYTES, ATTACHMENT_MIME_ALLOWLIST } from './helpers.js'

async function requireMember(db: D1Database, teamId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, userId)
    .first<{ role: string }>()
  return !!row
}

// Default close_steps for a task that doesn't specify its own — used only when the
// caller omits close_steps entirely. Unlike learn_from_session (stored but never
// read — see 0029_team_learn_from_session.sql), memory_enabled actually gates
// whether /tsq-end-session-memory is injected between the learning and cleanup steps.
async function defaultCloseSteps(db: D1Database, teamId: string): Promise<string[]> {
  const team = await db.prepare('SELECT memory_enabled FROM teams WHERE id = ?').bind(teamId).first<{ memory_enabled: number }>()
  const steps = ['/tsq-end-session-learning']
  if (team?.memory_enabled) steps.push('/tsq-end-session-memory')
  steps.push('/tsq-cleanup')
  return steps
}

export async function list(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.searchParams.get('agent_id')
  const status = url.searchParams.get('status')
  const teamId = url.searchParams.get('team_id')

  // Determine which team to scope to — require team_id query param for now
  if (!teamId) return err('team_id_required', 400)
  if (!(await requireMember(env.DB, teamId, auth.userId))) return err('not_found', 404)

  // supervisor_report_count / last_supervisor_at only count role='supervisor' messages
  // with type='report' — i.e. actual findings/escalations, not routine 'working_fine'
  // progress pings (type='progress', see daemon.ts supervisorReport()). Reuses the
  // existing all_m join so it costs nothing extra query-plan-wise.
  let query = `
    SELECT t.id, t.team_id, t.agent_id, t.sender_id, t.subject, t.status, t.created_at, t.started_at, t.completed_at,
           pt.planner_id,
           m.role as first_message_role, m.type as first_message_type,
           MAX(all_m.scheduled_at) as scheduled_at,
           SUM(CASE WHEN all_m.role = 'supervisor' AND all_m.type = 'report' THEN 1 ELSE 0 END) as supervisor_report_count,
           MAX(CASE WHEN all_m.role = 'supervisor' AND all_m.type = 'report' THEN all_m.created_at END) as last_supervisor_at
    FROM tasks t
    LEFT JOIN planner_task pt ON pt.task_id = t.id
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
    .prepare('SELECT id, team_id, agent_id, sender_id, subject, status, created_at, started_at, completed_at, settings, close_steps, close_steps_active_idx, grade, tui_blocked FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ id: string; team_id: string; agent_id: string; sender_id: string; subject: string; status: string; created_at: number; started_at: number | null; completed_at: number | null; settings: string | null; close_steps: string | null; close_steps_active_idx: number; grade: number | null; tui_blocked: number }>()

  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('not_found', 404)

  let closeSteps: string[] | null = null
  try { closeSteps = task.close_steps ? JSON.parse(task.close_steps) : null } catch { closeSteps = null }

  const activeSession = await env.DB
    .prepare('SELECT id FROM sessions WHERE task_id = ? AND closed_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .bind(taskId)
    .first<{ id: string }>()

  return json({ ...task, settings: task.settings ? JSON.parse(task.settings) : null, close_steps: closeSteps, session_id: activeSession?.id ?? null })
}

export async function gradeTask(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const body = await req.json<{ grade?: number | null }>().catch(() => ({} as { grade?: number | null }))

  const task = await env.DB
    .prepare('SELECT team_id FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string }>()
  if (!task) return err('not_found', 404)
  if (!(await requireMember(env.DB, task.team_id, auth.userId))) return err('forbidden', 403)

  await env.DB
    .prepare('UPDATE tasks SET grade = ? WHERE id = ?')
    .bind(body.grade ?? null, taskId)
    .run()

  // Planner hook — engine resolves link via planner_task; returns [] for non-linked tasks
  if (body.grade != null) {
    const source: VerdictSource = { kind: 'inbox_grade', grade: body.grade === 1 ? 1 : 0 }
    await makePlannerEngine().onVerdict(env.DB, taskId, source)
  }

  return json({ ok: true })
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
  let agent_id: string | undefined
  let subject: string | undefined
  let team_id: string | undefined
  let taskBody: string | undefined
  let scheduled_at: number | undefined
  let auto_close: boolean | undefined
  let save_tokens: { enabled: boolean; level: string } | undefined
  let close_steps: string[] | undefined
  let files: File[] = []

  const contentType = req.headers.get('Content-Type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData()
    agent_id = (form.get('agent_id') as string) || undefined
    subject = (form.get('subject') as string) || undefined
    team_id = (form.get('team_id') as string) || undefined
    taskBody = (form.get('body') as string) || undefined
    const scheduledRaw = form.get('scheduled_at')
    scheduled_at = scheduledRaw ? Number(scheduledRaw) : undefined
    auto_close = form.get('auto_close') === 'true'
    const saveTokensRaw = form.get('save_tokens')
    if (typeof saveTokensRaw === 'string' && saveTokensRaw) {
      try { save_tokens = JSON.parse(saveTokensRaw) } catch { /* ignore malformed field */ }
    }
    const closeStepsRaw = form.get('close_steps')
    if (typeof closeStepsRaw === 'string' && closeStepsRaw) {
      try { close_steps = JSON.parse(closeStepsRaw) } catch { /* ignore malformed field */ }
    }
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
    const body = await req.json<{ agent_id?: string; subject?: string; team_id?: string; body?: string; scheduled_at?: number; auto_close?: boolean; save_tokens?: { enabled: boolean; level: string }; close_steps?: string[] }>().catch(() => ({} as { agent_id?: string; subject?: string; team_id?: string; body?: string; scheduled_at?: number; auto_close?: boolean; save_tokens?: { enabled: boolean; level: string }; close_steps?: string[] }))
    ;({ agent_id, subject, team_id, body: taskBody, scheduled_at, auto_close, save_tokens, close_steps } = body)
  }

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
  const firstMessageId = ulid()
  const now = Date.now()
  const isScheduled = scheduled_at && scheduled_at > now

  const autoCloseVal = auto_close ? 1 : 0
  const settingsVal = save_tokens ? JSON.stringify({ save_tokens }) : null
  const closeStepsVal = close_steps?.length
    ? JSON.stringify(close_steps)
    : JSON.stringify(await defaultCloseSteps(env.DB, team_id))

  if (isScheduled) {
    await env.DB.batch([
      // Use 'scheduled' status so the daemon doesn't pick it up before the scheduled time
      env.DB.prepare('INSERT INTO tasks (id, team_id, agent_id, sender_id, subject, status, created_at, auto_close, settings, close_steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(taskId, team_id, agent_id, auth.userId, subject.trim(), TaskStatus.Scheduled, now, autoCloseVal, settingsVal, closeStepsVal),
      // Insert initial user message with scheduled_at
      env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, type, body, created_at, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(firstMessageId, taskId, auth.userId, 'user', MessageType.Inbox, taskBody?.trim() || subject.trim(), now, scheduled_at),
    ])
    const attachments = await storeAttachments(env, agent_id, firstMessageId, files)
    return json({ id: taskId, status: TaskStatus.Scheduled, attachments }, 201)
  }

  await env.DB.batch([
    env.DB.prepare('INSERT INTO tasks (id, team_id, agent_id, sender_id, subject, status, created_at, auto_close, settings, close_steps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(taskId, team_id, agent_id, auth.userId, subject.trim(), TaskStatus.Pending, now, autoCloseVal, settingsVal, closeStepsVal),
    // Insert initial user message — use body if provided, else fall back to subject
    env.DB.prepare('INSERT INTO messages (id, task_id, sender_id, role, type, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(firstMessageId, taskId, auth.userId, 'user', MessageType.Inbox, taskBody?.trim() || subject.trim(), now),
  ])

  const attachments = await storeAttachments(env, agent_id, firstMessageId, files)

  await bumpInboxVersion(env, agent_id)

  return json({ id: taskId, status: TaskStatus.Pending, attachments }, 201)
}

export async function closeTask(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const taskId = url.pathname.split('/')[2]

  const task = await env.DB
    .prepare('SELECT team_id, agent_id, close_steps, auto_close FROM tasks WHERE id = ?')
    .bind(taskId)
    .first<{ team_id: string; agent_id: string; close_steps: string | null; auto_close: number }>()
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

  // Planner hook — errors are logged but must not fail the close request
  try {
    await onTaskDone(env.DB, taskId)
  } catch (e) {
    console.error('[planner] onTaskDone failed for task', taskId, e)
  }

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

import { Router, IRequest } from 'itty-router'
import { withFirebaseAuth, withDaemonAgentAuth, mintCliToken, revokeCliToken, err, json } from './auth.js'
export { TerminalRelay } from './terminal/relay.js'
import { checkCircuitBreaker, checkCliTokenRateLimit } from './middleware/circuitBreaker.js'
import * as teams    from './routes/teams.js'
import * as agents   from './routes/agents.js'
import * as tasks    from './routes/tasks.js'
import * as messages from './routes/messages.js'
import * as daemon   from './routes/daemon.js'
import * as me       from './routes/me.js'
import * as notes    from './routes/notes.js'
import * as conveyors from './routes/conveyors.js'
import * as skills     from './routes/skills.js'
import * as subAgents  from './routes/sub-agents.js'
import * as commands   from './routes/commands.js'
import * as planners   from './routes/planners.js'
import * as portals    from './routes/portals.js'
import type { Env, AuthContext, DaemonContext } from './types.js'


type FirebaseHandler = (req: Request, env: Env, ctx: ExecutionContext, auth: AuthContext) => Promise<Response>
type DaemonHandler  = (req: Request, env: Env, ctx: ExecutionContext, ctx2: DaemonContext) => Promise<Response>

const router = Router()

function getCorsHeaders(req: Request, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const origin = req.headers.get('Origin') ?? ''
  const allowedOrigin = allowed.includes(origin) ? origin : (allowed[0] ?? '')
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TSQ-Agent',
  }
}

// Wrap a route handler with Firebase auth middleware
function firebaseRoute(handler: FirebaseHandler) {
  return async (req: IRequest, env: Env, ctx: ExecutionContext) => {
    const auth = await withFirebaseAuth(req as Request, env)
    if (auth instanceof Response) return auth
    return handler(req as Request, env, ctx, auth)
  }
}

// Wrap a route handler with Firebase-based daemon auth middleware.
// Reads the agent ID from X-TSQ-Agent header and verifies ownership.
function daemonRoute(handler: DaemonHandler) {
  return async (req: IRequest, env: Env, ctx: ExecutionContext) => {
    const d = await withDaemonAgentAuth(req as Request, env)
    if (d instanceof Response) return d
    return handler(req as Request, env, ctx, d)
  }
}

// CORS preflight
router.options('*', (req: IRequest, env: Env) => new Response(null, { status: 204, headers: getCorsHeaders(req as Request, env) }))

// ── Auth ───────────────────────────────────────────────────────────────────────
// Exchanges a Firebase ID token (from tsq login) for a long-lived CLI token (90 days).
// The portal always uses short-lived Firebase ID tokens; only the daemon uses this.
router.post('/auth/cli-token', firebaseRoute(async (_req, env, _ctx, auth) => {
  const rateCheck = await checkCliTokenRateLimit(env, auth.userId)
  if (rateCheck) return rateCheck
  const { token, expiresAt } = await mintCliToken(env, auth.userId)
  return json({ token, expires_at: expiresAt, expires_in: 90 * 24 * 3600 })
}))
// Revoke the current CLI token — used by `tsq logout`.
router.delete('/auth/cli-token', (req: IRequest, env: Env) => revokeCliToken(req as Request, env))

// ── Browser routes (Firebase JWT) ─────────────────────────────────────────────
router.get('/me', firebaseRoute(me.getMe))
router.post('/me/push/token', firebaseRoute(me.savePushToken))
router.post('/admin/users/:userId/plan', (req: IRequest, env: Env) => me.setUserPlan(req as Request, env))
router.get('/teams', firebaseRoute(teams.list))
router.post('/teams',                    firebaseRoute(teams.create))
router.patch('/teams/:teamId',           firebaseRoute(teams.updateSettings))
router.delete('/teams/:teamId',          firebaseRoute(teams.deactivate))
router.get ('/teams/:teamId/members',              firebaseRoute(teams.listMembers))
router.post('/teams/:teamId/members',              firebaseRoute(teams.addMember))
router.delete('/teams/:teamId/members/:userId',    firebaseRoute(teams.removeMember))
router.get ('/teams/:teamId/agents',     firebaseRoute(agents.list))
router.post('/teams/:teamId/agents',     firebaseRoute(agents.create))
router.post('/teams/:teamId/tokens',     firebaseRoute(agents.createToken))
router.patch('/teams/:teamId/agents/:agentId',       firebaseRoute(agents.updateAgent))
router.post('/teams/:teamId/agents/:agentId/reset', firebaseRoute(agents.resetAgent))
router.post('/teams/:teamId/agents/:agentId/pause', firebaseRoute(agents.pauseAgent))
router.delete('/teams/:teamId/agents/:agentId', firebaseRoute(agents.deleteAgent))

router.get ('/teams/:teamId/conveyors',                 firebaseRoute(conveyors.list))
router.post('/teams/:teamId/conveyors',                 firebaseRoute(conveyors.create))
router.put   ('/teams/:teamId/conveyors/:conveyorId',   firebaseRoute(conveyors.update))
router.delete('/teams/:teamId/conveyors/:conveyorId',   firebaseRoute(conveyors.remove))

router.get ('/teams/:teamId/notes',                    firebaseRoute(notes.list))
router.post('/teams/:teamId/notes',                    firebaseRoute(notes.create))
router.get ('/teams/:teamId/notes/:noteId',            firebaseRoute(notes.get))
router.put ('/teams/:teamId/notes/:noteId',            firebaseRoute(notes.update))
router.delete('/teams/:teamId/notes/:noteId',          firebaseRoute(notes.remove))
router.get ('/teams/:teamId/notes/:noteId/comments',   firebaseRoute(notes.listComments))
router.post  ('/teams/:teamId/notes/:noteId/comments',             firebaseRoute(notes.createComment))
router.delete('/teams/:teamId/notes/:noteId/comments/:commentId',  firebaseRoute(notes.deleteComment))
router.post  ('/teams/:teamId/notes/:noteId/convert',              firebaseRoute(notes.convertToInbox))
router.post  ('/teams/:teamId/notes/:noteId/critique',             firebaseRoute(notes.critique))
router.get   ('/teams/:teamId/notes/:noteId/tasks',                firebaseRoute(notes.listLinkedTasks))
router.post  ('/teams/:teamId/notes/:noteId/archive',              firebaseRoute(notes.archive))
router.delete('/teams/:teamId/notes/:noteId/archive',              firebaseRoute(notes.unarchive))

router.get   ('/teams/:teamId/skills',              firebaseRoute(skills.list))
router.post  ('/teams/:teamId/skills',              firebaseRoute(skills.create))
router.get   ('/teams/:teamId/skills/:skillId',     firebaseRoute(skills.get))
router.put   ('/teams/:teamId/skills/:skillId',     firebaseRoute(skills.update))
router.delete('/teams/:teamId/skills/:skillId',     firebaseRoute(skills.remove))

router.get   ('/teams/:teamId/sub-agents',                   firebaseRoute(subAgents.list))
router.post  ('/teams/:teamId/sub-agents',                   firebaseRoute(subAgents.create))
router.get   ('/teams/:teamId/sub-agents/:subAgentId',       firebaseRoute(subAgents.get))
router.put   ('/teams/:teamId/sub-agents/:subAgentId',       firebaseRoute(subAgents.update))
router.delete('/teams/:teamId/sub-agents/:subAgentId',       firebaseRoute(subAgents.remove))

router.get   ('/teams/:teamId/commands',                 firebaseRoute(commands.list))
router.post  ('/teams/:teamId/commands',                 firebaseRoute(commands.create))
router.get   ('/teams/:teamId/commands/:commandId',      firebaseRoute(commands.get))
router.put   ('/teams/:teamId/commands/:commandId',      firebaseRoute(commands.update))
router.delete('/teams/:teamId/commands/:commandId',      firebaseRoute(commands.remove))

router.get   ('/teams/:teamId/planners',          firebaseRoute(planners.list))
router.post  ('/teams/:teamId/planners',          firebaseRoute(planners.create))
router.get   ('/teams/:teamId/planners/:id',      firebaseRoute(planners.get))
router.patch ('/teams/:teamId/planners/:id',      firebaseRoute(planners.patch))
router.delete('/teams/:teamId/planners/:id',      firebaseRoute(planners.del))

router.get ('/tasks',                    firebaseRoute(tasks.list))
router.post('/tasks',                    firebaseRoute(tasks.create))
router.get   ('/tasks/:taskId',          firebaseRoute(tasks.get))
router.put   ('/tasks/:taskId',          firebaseRoute(tasks.update))
router.patch ('/tasks/:taskId/settings', firebaseRoute(tasks.updateSettings))
router.patch ('/tasks/:taskId/grade',                     firebaseRoute(tasks.gradeTask))
router.patch ('/tasks/:taskId/messages/:msgId/grade',     firebaseRoute(messages.gradeMessage))
router.post('/tasks/:taskId/close',      firebaseRoute(tasks.closeTask))
router.post('/tasks/:taskId/forward',    firebaseRoute(tasks.forwardTask))
router.delete('/tasks/:taskId',          firebaseRoute(tasks.deleteTask))
router.get ('/tasks/:taskId/messages',                        firebaseRoute(messages.list))
router.post('/tasks/:taskId/messages',                        firebaseRoute(messages.create))
router.put ('/tasks/:taskId/messages/:msgId',                firebaseRoute(messages.update))
router.delete('/tasks/:taskId/messages/:msgId',              firebaseRoute(messages.remove))
router.get ('/tasks/:taskId/messages/:msgId/transcript',      firebaseRoute(messages.getTranscript))
router.get ('/tasks/:taskId/logs',       firebaseRoute(tasks.logs))

// ── Daemon routes (Firebase JWT) ──────────────────────────────────────────────
router.get ('/daemon/user/agents',       (req: IRequest, env: Env, ctx: ExecutionContext) => daemon.userAgents(req as Request, env, ctx))
router.get ('/daemon/user/skills',       firebaseRoute(skills.userSkills))
router.get ('/daemon/user/sub-agents',   firebaseRoute(subAgents.userSubAgents))
router.get ('/daemon/sub-agents/:subAgentId', firebaseRoute(subAgents.daemonSubAgentGet))
router.get ('/daemon/user/commands',     firebaseRoute(commands.userCommands))
router.get ('/daemon/commands/:commandId', firebaseRoute(commands.daemonCommandGet))
router.post('/daemon/heartbeat/batch',   (req: IRequest, env: Env, ctx: ExecutionContext) => daemon.batchHeartbeat(req as Request, env, ctx))
router.post('/daemon/complete',          daemonRoute(daemon.complete))
router.post('/daemon/session/open',      daemonRoute(daemon.sessionOpen))
router.post('/daemon/session/close',     daemonRoute(daemon.sessionClose))
router.post('/daemon/session/notify',    daemonRoute(daemon.sessionNotify))
router.post('/daemon/session/message',  daemonRoute(daemon.sessionMessage))
router.post('/daemon/session/state',    (req: IRequest, env: Env, ctx: ExecutionContext) => daemon.sessionState(req as Request, env, ctx))
router.post('/daemon/r2/presign',        daemonRoute(daemon.presignUpload))
router.post('/daemon/messages/:msgId/attach', daemonRoute(daemon.messageAttach))
router.post('/daemon/sessions/:sessionId/attach', daemonRoute(daemon.sessionAttach))
router.post('/daemon/permission/request',         daemonRoute(daemon.permissionRequest))
router.post('/daemon/supervisor/report',          daemonRoute(daemon.supervisorReport))
router.get ('/daemon/skills/:skillId',             firebaseRoute(skills.daemonSkillGet))
router.post('/daemon/skills',                     daemonRoute(skills.daemonUpsert))

// ── Portal routes (browser) ───────────────────────────────────────────────────
router.get ('/portals',                              firebaseRoute(portals.list))
router.post('/portals',                              firebaseRoute(portals.create))
router.get ('/portals/:portalId',                    firebaseRoute(portals.get))
router.post('/portals/:portalId/close',              firebaseRoute(portals.browserClose))

// ── Portal routes (daemon) ────────────────────────────────────────────────────
router.get ('/daemon/portal/poll',    daemonRoute(portals.daemonPoll))
router.post('/daemon/portal/open',    daemonRoute(portals.daemonOpen))
router.post('/daemon/portal/close',   daemonRoute(portals.daemonClose))

// Issue a short-lived one-time ticket so the browser can open the relay WebSocket
// without putting a long-lived Firebase JWT in the URL (which would appear in logs).
router.post('/terminal/ticket', firebaseRoute(async (req, env, _ctx, auth) => {
  const body = await (req as Request).json<{ session_id?: string }>().catch(() => ({} as { session_id?: string }))
  if (!body.session_id) return err('missing_fields', 400)

  // Accept portal relay sessions (portals.session_id set by daemonOpen) and task session IDs.
  // Only match portals.session_id — not portals.id — so pending portals (session_id IS NULL)
  // cannot receive a ticket that would fail at WebSocket upgrade time.
  const [portalRow, sessionRow] = await Promise.all([
    env.DB
      .prepare('SELECT p.team_id FROM portals p WHERE p.session_id = ?')
      .bind(body.session_id)
      .first<{ team_id: string }>(),
    env.DB
      .prepare('SELECT t.team_id FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?')
      .bind(body.session_id)
      .first<{ team_id: string }>(),
  ])

  const teamId = portalRow?.team_id ?? sessionRow?.team_id
  if (!teamId) return err('not_found', 404)

  const isMember = await env.DB
    .prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(teamId, auth.userId)
    .first()
  if (!isMember) return err('forbidden', 403)

  // Store ticket keyed by UUID; value = session_id so the relay route can verify it
  const ticket = crypto.randomUUID()
  await env.POLL_CACHE.put(`tt:${ticket}`, body.session_id, { expirationTtl: 30 })
  return json({ ticket })
}))

// ── Terminal relay (Durable Object WebSocket) ─────────────────────────────────
router.get('/terminal/:sessionId', async (req: IRequest, env: Env) => {
  const sessionId = (req.params as { sessionId: string }).sessionId
  const url = new URL((req as Request).url)

  if ((req as Request).headers.has('X-TSQ-Agent')) {
    // Daemon path — validate daemon CLI token + confirm session ownership.
    // Check both portals table (session_id set by daemonOpen) and sessions table
    // (task relay sessions from lifecycle.go use the sessions table, not portals).
    const d = await withDaemonAgentAuth(req as Request, env)
    if (d instanceof Response) return d
    const [portalRow, sessionRow] = await Promise.all([
      env.DB
        .prepare('SELECT agent_id FROM portals WHERE session_id = ?')
        .bind(sessionId)
        .first<{ agent_id: string }>(),
      env.DB
        .prepare('SELECT agent_id FROM sessions WHERE id = ?')
        .bind(sessionId)
        .first<{ agent_id: string }>(),
    ])
    const owner = portalRow?.agent_id ?? sessionRow?.agent_id
    if (!owner || owner !== d.agentId) return err('forbidden', 403)
  } else {
    // Browser path — one-time ticket issued by POST /terminal/ticket.
    // Tickets expire after 30 s and are deleted on first use, keeping the
    // Firebase JWT out of the WebSocket URL (and therefore out of access logs).
    const ticket = url.searchParams.get('ticket')
    if (!ticket) return err('unauthorized', 401)
    const stored = await env.POLL_CACHE.get(`tt:${ticket}`)
    if (!stored || stored !== sessionId) return err('forbidden', 403)
    // Delete after the upgrade succeeds so the ticket remains valid for retry
    // if the DO fetch throws (e.g. cold-start race). The 30 s TTL is the fallback.
    const id = env.TERMINAL_RELAY.idFromName(sessionId)
    const res = await env.TERMINAL_RELAY.get(id).fetch(req as Request)
    await env.POLL_CACHE.delete(`tt:${ticket}`)
    return res
  }

  const id = env.TERMINAL_RELAY.idFromName(sessionId)
  return env.TERMINAL_RELAY.get(id).fetch(req as Request)
})

router.all('*', () => err('not_found', 404))

function addCors(res: Response, req: Request, env: Env): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(getCorsHeaders(req, env))) headers.set(k, v)
  return new Response(res.body, { status: res.status, headers })
}

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    try {
      const blocked = await checkCircuitBreaker(req, env)
      if (blocked) return addCors(blocked, req, env)

      const res = await router.fetch(req, env, ctx)
      return addCors(res, req, env)
    } catch (e) {
      console.error('Unhandled worker error:', e)
      return addCors(new Response(JSON.stringify({ error: 'internal_error', detail: String(e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }), req, env)
    }
  },

}

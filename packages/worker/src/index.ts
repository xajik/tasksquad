import { Router, IRequest } from 'itty-router'
import { withFirebaseAuth, withDaemonAgentAuth, mintCliToken, revokeCliToken, err, json } from './auth.js'
import * as teams    from './routes/teams.js'
import * as agents   from './routes/agents.js'
import * as tasks    from './routes/tasks.js'
import * as messages from './routes/messages.js'
import * as daemon   from './routes/daemon.js'
import * as live     from './routes/live.js'
import * as me       from './routes/me.js'
import * as notes    from './routes/notes.js'
import type { Env, AuthContext, DaemonContext } from './types.js'
export { AgentRelay } from './relay.js'

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

router.get ('/teams/:teamId/notes',                    firebaseRoute(notes.list))
router.post('/teams/:teamId/notes',                    firebaseRoute(notes.create))
router.get ('/teams/:teamId/notes/:noteId',            firebaseRoute(notes.get))
router.put ('/teams/:teamId/notes/:noteId',            firebaseRoute(notes.update))
router.delete('/teams/:teamId/notes/:noteId',          firebaseRoute(notes.remove))
router.get ('/teams/:teamId/notes/:noteId/comments',   firebaseRoute(notes.listComments))
router.post  ('/teams/:teamId/notes/:noteId/comments',             firebaseRoute(notes.createComment))
router.delete('/teams/:teamId/notes/:noteId/comments/:commentId',  firebaseRoute(notes.deleteComment))
router.post  ('/teams/:teamId/notes/:noteId/convert',              firebaseRoute(notes.convertToInbox))

router.get ('/tasks',                    firebaseRoute(tasks.list))
router.post('/tasks',                    firebaseRoute(tasks.create))
router.get ('/tasks/:taskId',            firebaseRoute(tasks.get))
router.put ('/tasks/:taskId',            firebaseRoute(tasks.update))
router.post('/tasks/:taskId/close',      firebaseRoute(tasks.closeTask))
router.post('/tasks/:taskId/forward',    firebaseRoute(tasks.forwardTask))
router.delete('/tasks/:taskId',          firebaseRoute(tasks.deleteTask))
router.get ('/tasks/:taskId/messages',                        firebaseRoute(messages.list))
router.post('/tasks/:taskId/messages',                        firebaseRoute(messages.create))
router.put ('/tasks/:taskId/messages/:msgId',                firebaseRoute(messages.update))
router.delete('/tasks/:taskId/messages/:msgId',              firebaseRoute(messages.remove))
router.get ('/tasks/:taskId/messages/:msgId/transcript',      firebaseRoute(messages.getTranscript))
router.get ('/tasks/:taskId/logs',       firebaseRoute(tasks.logs))

router.get ('/live/:agentId',            (req: IRequest, env: Env) => live.connect(req as Request, env))

// ── Daemon routes (Firebase JWT) ──────────────────────────────────────────────
router.get ('/daemon/user/agents',       (req: IRequest, env: Env, ctx: ExecutionContext) => daemon.userAgents(req as Request, env, ctx))
router.post('/daemon/heartbeat/batch',   (req: IRequest, env: Env, ctx: ExecutionContext) => daemon.batchHeartbeat(req as Request, env, ctx))
router.post('/daemon/complete',          daemonRoute(daemon.complete))
router.post('/daemon/session/open',      daemonRoute(daemon.sessionOpen))
router.post('/daemon/session/close',     daemonRoute(daemon.sessionClose))
router.post('/daemon/session/notify',    daemonRoute(daemon.sessionNotify))
router.post('/daemon/session/message',  daemonRoute(daemon.sessionMessage))
router.get ('/daemon/viewers/:agentId',  daemonRoute(daemon.viewers))
router.post('/daemon/push/:agentId',     daemonRoute(daemon.push))
router.post('/daemon/r2/presign',        daemonRoute(daemon.presignUpload))
router.post('/daemon/messages/:msgId/attach', daemonRoute(daemon.messageAttach))
router.post('/daemon/sessions/:sessionId/attach', daemonRoute(daemon.sessionAttach))
router.post('/daemon/permission/request',         daemonRoute(daemon.permissionRequest))

router.all('*', () => err('not_found', 404))

function addCors(res: Response, req: Request, env: Env): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(getCorsHeaders(req, env))) headers.set(k, v)
  return new Response(res.body, { status: res.status, headers })
}

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    try {
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

import { Router, IRequest } from 'itty-router'
import { withFirebaseAuth, withDaemonAuth, err } from './auth.js'
import * as teams    from './routes/teams.js'
import * as agents   from './routes/agents.js'
import * as tasks    from './routes/tasks.js'
import * as messages from './routes/messages.js'
import * as daemon   from './routes/daemon.js'
import * as live     from './routes/live.js'
import type { Env, AuthContext, DaemonContext } from './types.js'
export { AgentRelay } from './relay.js'

type FirebaseHandler = (req: Request, env: Env, ctx: ExecutionContext, auth: AuthContext) => Promise<Response>
type DaemonHandler  = (req: Request, env: Env, ctx: ExecutionContext, ctx2: DaemonContext) => Promise<Response>

const router = Router()

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-TSQ-Token',
}

// Wrap a route handler with Firebase auth middleware
function firebaseRoute(handler: FirebaseHandler) {
  return async (req: IRequest, env: Env, ctx: ExecutionContext) => {
    const auth = await withFirebaseAuth(req as Request, env)
    if (auth instanceof Response) return auth
    return handler(req as Request, env, ctx, auth)
  }
}

// Wrap a route handler with daemon token auth middleware
function daemonRoute(handler: DaemonHandler) {
  return async (req: IRequest, env: Env, ctx: ExecutionContext) => {
    const d = await withDaemonAuth(req as Request, env)
    if (d instanceof Response) return d
    return handler(req as Request, env, ctx, d)
  }
}

// CORS preflight
router.options('*', () => new Response(null, { status: 204, headers: CORS_HEADERS }))

// ── Browser routes (Firebase JWT) ─────────────────────────────────────────────
router.post('/teams',                    firebaseRoute(teams.create))
router.get ('/teams/:teamId/members',    firebaseRoute(teams.listMembers))
router.get ('/teams/:teamId/agents',     firebaseRoute(agents.list))
router.post('/teams/:teamId/agents',     firebaseRoute(agents.create))
router.post('/teams/:teamId/tokens',     firebaseRoute(agents.createToken))

router.get ('/tasks',                    firebaseRoute(tasks.list))
router.post('/tasks',                    firebaseRoute(tasks.create))
router.get ('/tasks/:taskId',            firebaseRoute(tasks.get))
router.get ('/tasks/:taskId/messages',   firebaseRoute(messages.list))
router.post('/tasks/:taskId/messages',   firebaseRoute(messages.create))
router.get ('/tasks/:taskId/logs',       firebaseRoute(tasks.logs))

router.get ('/live/:agentId',            (req: IRequest, env: Env) => live.connect(req as Request, env))

// ── Daemon routes (X-TSQ-Token) ───────────────────────────────────────────────
router.post('/daemon/heartbeat',         daemonRoute(daemon.heartbeat))
router.post('/daemon/complete',          daemonRoute(daemon.complete))
router.post('/daemon/session/open',      daemonRoute(daemon.sessionOpen))
router.post('/daemon/session/close',     daemonRoute(daemon.sessionClose))
router.get ('/daemon/viewers/:agentId',  daemonRoute(daemon.viewers))
router.post('/daemon/push/:agentId',     daemonRoute(daemon.push))
router.get ('/daemon/r2/presign',        daemonRoute(daemon.presignUpload))

router.all('*', () => err('not_found', 404))

function addCors(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return new Response(res.body, { status: res.status, headers })
}

export default {
  fetch: async (req: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    try {
      const res = await router.fetch(req, env, ctx)
      return addCors(res)
    } catch (e) {
      console.error('Unhandled worker error:', e)
      return addCors(new Response(JSON.stringify({ error: 'internal_error', detail: String(e) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
    }
  },
}

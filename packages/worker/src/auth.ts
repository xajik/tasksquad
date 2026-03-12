import { CloudFireAuth } from 'cloudfire-auth'
import { ulid } from 'ulidx'
import type { Env, AuthContext, DaemonContext } from './types.js'

function getAuth(env: Env): CloudFireAuth {
  const serviceAccount = JSON.parse(atob(env.FIREBASE_SERVICE_ACCOUNT_KEY))
  return new CloudFireAuth(serviceAccount, env.JWKS_CACHE)
}

export async function withFirebaseAuth(
  req: Request,
  env: Env
): Promise<AuthContext | Response> {
  const header = req.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const token = header.slice(7)
  let decoded: { uid?: string; sub?: string; email?: string }

  try {
    const auth = getAuth(env)
    decoded = await auth.verifyIdToken(token)
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const firebaseUid = decoded.uid ?? decoded.sub ?? ''
  if (!firebaseUid) return new Response(JSON.stringify({ error: 'invalid_token' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
  const email = decoded.email ?? ''
  const { id: userId, plan } = await upsertUser(env.DB, firebaseUid, email)
  return { uid: firebaseUid, email, userId, plan }
}

async function upsertUser(db: D1Database, firebaseUid: string, email: string): Promise<{ id: string; plan: 'free' | 'pro' }> {
  const existing = await db
    .prepare('SELECT id, plan FROM users WHERE firebase_uid = ?')
    .bind(firebaseUid)
    .first<{ id: string; plan: string }>()

  if (existing) return { id: existing.id, plan: (existing.plan === 'pro' ? 'pro' : 'free') }

  const id = ulid()
  await db
    .prepare('INSERT INTO users (id, firebase_uid, email, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, firebaseUid, email, Date.now())
    .run()

  return { id, plan: 'free' }
}

// withDaemonAgentAuth authenticates a daemon request using a Firebase ID token
// (Authorization: Bearer) and validates that the agent in X-TSQ-Agent header
// belongs to one of the authenticated user's teams.
export async function withDaemonAgentAuth(
  req: Request,
  env: Env
): Promise<DaemonContext | Response> {
  const firebaseResult = await withFirebaseAuth(req, env)
  if (firebaseResult instanceof Response) return firebaseResult

  const agentId = req.headers.get('X-TSQ-Agent')
  if (!agentId) {
    return new Response(JSON.stringify({ error: 'missing_agent_id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Verify the agent belongs to a team the user is a member of.
  const row = await env.DB
    .prepare(`
      SELECT a.team_id
      FROM agents a
      JOIN team_members m ON m.team_id = a.team_id
      WHERE a.id = ? AND m.user_id = ?
    `)
    .bind(agentId, firebaseResult.userId)
    .first<{ team_id: string }>()

  if (!row) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return { teamId: row.team_id, agentId, tokenId: '' }
}

// withDaemonBatchAuth authenticates a batch heartbeat using a Firebase ID token
// and validates that all supplied agent IDs belong to the authenticated user's teams.
export async function withDaemonBatchAuth(
  req: Request,
  agentIds: string[],
  env: Env
): Promise<DaemonContext[] | Response> {
  const firebaseResult = await withFirebaseAuth(req, env)
  if (firebaseResult instanceof Response) return firebaseResult

  if (!agentIds.length) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Verify all agents belong to teams the user is a member of (single batch query).
  const batchResults = await env.DB.batch(
    agentIds.map(id =>
      env.DB.prepare(`
        SELECT a.id, a.team_id
        FROM agents a
        JOIN team_members m ON m.team_id = a.team_id
        WHERE a.id = ? AND m.user_id = ?
      `).bind(id, firebaseResult.userId)
    )
  )
  const rows = batchResults.map(r =>
    (r.results[0] as { id: string; team_id: string } | undefined)
  )

  if (rows.some(r => !r)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return (rows as { id: string; team_id: string }[]).map(r => ({
    teamId: r.team_id,
    agentId: r.id,
    tokenId: '',
  }))
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Used by SSE routes where EventSource cannot send Authorization header
export async function verifyTokenString(token: string, env: Env): Promise<AuthContext | null> {
  try {
    const auth = getAuth(env)
    const decoded = await auth.verifyIdToken(token) as { uid?: string; sub?: string; email?: string }
    const firebaseUid = decoded.uid ?? decoded.sub ?? ''
    if (!firebaseUid) return null
    const email = decoded.email ?? ''
    const { id: userId, plan } = await upsertUser(env.DB, firebaseUid, email)
    return { uid: firebaseUid, email, userId, plan }
  } catch {
    return null
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function err(message: string, status: number): Response {
  return json({ error: message }, status)
}

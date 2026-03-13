import { CloudFireAuth } from 'cloudfire-auth'
import { ulid } from 'ulidx'
import type { Env, AuthContext, DaemonContext } from './types.js'

const CLI_TOKEN_PREFIX = 'tsq_cli_'
const CLI_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

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

  // Long-lived CLI tokens are handled by a dedicated path — no Firebase call needed.
  if (token.startsWith(CLI_TOKEN_PREFIX)) {
    return withUserTokenAuth(token, env)
  }

  let decoded: { uid?: string; sub?: string; email?: string }

  try {
    const auth = getAuth(env)
    decoded = await auth.verifyIdToken(token)
  } catch {
    console.warn('[auth] Firebase ID token verification failed')
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

// withUserTokenAuth validates a tsq_cli_* token stored in user_cli_tokens.
async function withUserTokenAuth(token: string, env: Env): Promise<AuthContext | Response> {
  const hash = await sha256(token)
  const row = await env.DB.prepare(`
    SELECT t.id, t.user_id, t.expires_at, u.firebase_uid, u.email, u.plan
    FROM user_cli_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).bind(hash).first<{ id: string; user_id: string; expires_at: number; firebase_uid: string; email: string; plan: string }>()

  if (!row) {
    console.warn('[auth] CLI token not found — invalid or revoked')
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (row.expires_at < Date.now()) {
    const expiredAgo = Math.round((Date.now() - row.expires_at) / 86400000)
    console.warn(`[auth] CLI token expired ${expiredAgo}d ago for user ${row.user_id}`)
    return new Response(JSON.stringify({ error: 'token_expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const daysLeft = (row.expires_at - Date.now()) / 86400000
  console.log(`[auth] CLI token OK for user ${row.user_id} (${daysLeft.toFixed(0)}d remaining)`)

  // Update last_used without blocking the response.
  env.DB.prepare('UPDATE user_cli_tokens SET last_used = ? WHERE id = ?')
    .bind(Date.now(), row.id).run().catch(() => {})

  return {
    uid: row.firebase_uid,
    email: row.email,
    userId: row.user_id,
    plan: row.plan === 'pro' ? 'pro' : 'free',
  }
}

// mintCliToken creates a new long-lived CLI token for a user and returns the raw value.
// The raw token is returned exactly once — only its hash is stored in the DB.
export async function mintCliToken(
  env: Env,
  userId: string
): Promise<{ token: string; expiresAt: number }> {
  const randomBytes = new Uint8Array(32)
  crypto.getRandomValues(randomBytes)
  const raw = CLI_TOKEN_PREFIX + Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0')).join('')

  const hash = await sha256(raw)
  const id = ulid()
  const expiresAt = Date.now() + CLI_TOKEN_TTL_MS

  await env.DB.prepare(
    'INSERT INTO user_cli_tokens (id, user_id, token_hash, label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, userId, hash, 'CLI', expiresAt, Date.now()).run()

  console.log(`[auth] minted CLI token for user ${userId}, expires ${new Date(expiresAt).toISOString()}`)
  return { token: raw, expiresAt }
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

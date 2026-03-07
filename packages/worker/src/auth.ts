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
  let decoded: { uid: string; email?: string }

  try {
    const auth = getAuth(env)
    decoded = await auth.verifyIdToken(token)
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const email = decoded.email ?? ''
  const userId = await upsertUser(env.DB, decoded.uid, email)
  return { uid: decoded.uid, email, userId }
}

async function upsertUser(db: D1Database, firebaseUid: string, email: string): Promise<string> {
  const existing = await db
    .prepare('SELECT id FROM users WHERE firebase_uid = ?')
    .bind(firebaseUid)
    .first<{ id: string }>()

  if (existing) return existing.id

  const id = ulid()
  await db
    .prepare('INSERT INTO users (id, firebase_uid, email, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, firebaseUid, email, Date.now())
    .run()

  return id
}

// Daemon routes: validate X-TSQ-Token against daemon_tokens table
export async function withDaemonAuth(
  req: Request,
  env: Env
): Promise<DaemonContext | Response> {
  const raw = req.headers.get('X-TSQ-Token')
  if (!raw) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const hash = await sha256(raw)
  const row = await env.DB
    .prepare('SELECT id, team_id FROM daemon_tokens WHERE token_hash = ?')
    .bind(hash)
    .first<{ id: string; team_id: string }>()

  if (!row) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Update last_used timestamp
  await env.DB
    .prepare('UPDATE daemon_tokens SET last_used = ? WHERE id = ?')
    .bind(Date.now(), row.id)
    .run()

  return { teamId: row.team_id, tokenId: row.id }
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
    const decoded = await auth.verifyIdToken(token)
    const email = decoded.email ?? ''
    const userId = await upsertUser(env.DB, decoded.uid, email)
    return { uid: decoded.uid, email, userId }
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

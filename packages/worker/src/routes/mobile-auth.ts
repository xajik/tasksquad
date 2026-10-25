import { json, err, sha256, mintCliToken } from '../auth.js'
import type { AuthContext, Env } from '../types.js'
import { authFailureResponse } from '../middleware/rateLimit.js'

const CODE_TTL_MS = 5 * 60 * 1000
const MOBILE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const MOBILE_REDIRECT_URI = 'tasksquad-portal://oauth/callback'

// allowedRedirectUri accepts the iOS app callback plus the MCP server callbacks
// listed in MCP_REDIRECT_URIS (comma-separated, exact match).
export function allowedRedirectUri(env: Pick<Env, 'MCP_REDIRECT_URIS'>, uri: unknown): boolean {
  if (typeof uri !== 'string') return false
  if (uri === MOBILE_REDIRECT_URI) return true
  return (env.MCP_REDIRECT_URIS ?? '').split(',').map(s => s.trim()).filter(Boolean).includes(uri)
}

export function pkceChallenge(verifier: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then((digest) => {
    const bytes = new Uint8Array(digest)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  })
}

export function validVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value)
}

export async function createCode(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const body = await req.json<{ code_challenge?: string; redirect_uri?: string }>().catch((): { code_challenge?: string; redirect_uri?: string } => ({}))
  if (!allowedRedirectUri(env, body.redirect_uri) || !body.code_challenge || !/^[A-Za-z0-9_-]{43}$/.test(body.code_challenge)) {
    return err('invalid_authorization_request', 400)
  }

  const random = new Uint8Array(32)
  crypto.getRandomValues(random)
  const code = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')
  const now = Date.now()
  await env.DB.prepare(`DELETE FROM mobile_authorization_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL`).bind(now).run()
  await env.DB.prepare(`
    INSERT INTO mobile_authorization_codes (code_hash, user_id, code_challenge, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(await sha256(code), auth.userId, body.code_challenge, now + CODE_TTL_MS, now).run()
  return json({ code, expires_at: now + CODE_TTL_MS })
}

export async function exchangeCode(req: Request, env: Env): Promise<Response> {
  const body = await req.json<{ code?: string; code_verifier?: string; client?: string }>().catch((): { code?: string; code_verifier?: string; client?: string } => ({}))
  if (typeof body.code !== 'string' || !/^[a-f0-9]{64}$/.test(body.code) || !validVerifier(body.code_verifier)) {
    return err('invalid_authorization_code', 400)
  }
  const now = Date.now()
  const challenge = await pkceChallenge(body.code_verifier)
  const row = await env.DB.prepare(`
    UPDATE mobile_authorization_codes
    SET consumed_at = ?
    WHERE code_hash = ? AND code_challenge = ? AND consumed_at IS NULL AND expires_at > ?
    RETURNING user_id
  `).bind(now, await sha256(body.code), challenge, now).first<{ user_id: string }>()
  if (!row) return (await authFailureResponse(req, env)) ?? err('invalid_authorization_code', 401)

  // Mobile access uses the existing revocable user-token table, with a shorter
  // lifetime and a distinct label. The app revokes it on logout.
  const minted = await mintCliToken(env, row.user_id, body.client === 'mcp' ? 'MCP' : 'iOS Portal', MOBILE_TOKEN_TTL_MS)
  return json({ token: minted.token, expires_at: minted.expiresAt })
}

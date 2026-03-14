import { ulid } from 'ulidx'
import { json, err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'

export async function getMe(_req: Request, _env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  return json({ id: auth.userId, email: auth.email, plan: auth.plan })
}

export async function savePushToken(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const body = await req.json<{ token?: string }>().catch(() => ({} as { token?: string }))
  if (!body.token) return err('token_required', 400)

  await env.DB
    .prepare('INSERT OR REPLACE INTO push_tokens (id, user_id, token, created_at) VALUES (?, ?, ?, ?)')
    .bind(ulid(), auth.userId, body.token, Date.now())
    .run()

  return json({ ok: true })
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const bufA = enc.encode(a)
  const bufB = enc.encode(b)
  if (bufA.length !== bufB.length) return false
  return crypto.subtle.timingSafeEqual(bufA, bufB)
}

// Admin-only: manually set a user's plan
// Protected by X-Admin-Secret header matching ADMIN_SECRET env var
export async function setUserPlan(req: Request, env: Env): Promise<Response> {
  const secret = req.headers.get('X-Admin-Secret')
  if (!env.ADMIN_SECRET || !secret || !timingSafeEqual(secret, env.ADMIN_SECRET)) {
    return err('forbidden', 403)
  }

  const url = new URL(req.url)
  const parts = url.pathname.split('/')
  // /admin/users/:userId/plan
  const userId = parts[3]
  if (!userId) return err('user_id_required', 400)

  const body = await req.json<{ plan?: string }>().catch(() => ({} as { plan?: string }))
  if (!body.plan || !['free', 'pro'].includes(body.plan)) {
    return err('plan must be "free" or "pro"', 400)
  }

  const result = await env.DB
    .prepare('UPDATE users SET plan = ? WHERE id = ?')
    .bind(body.plan, userId)
    .run()

  if (!result.meta.changes) return err('user_not_found', 404)
  return json({ ok: true, plan: body.plan })
}

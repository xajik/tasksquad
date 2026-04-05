import type { Env } from '../types.js'

// CB-1: Per-IP request circuit breaker.
// Checks if the requesting IP is currently blocked.
// Returns a 403 Response if blocked, null if allowed.
export async function checkCircuitBreaker(req: Request, env: Env): Promise<Response | null> {
  if (!env.CB_KV) return null

  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown'
  const blocked = await env.CB_KV.get(`blocked:${ip}`)
  if (blocked) {
    console.warn(JSON.stringify({ event: 'circuit_blocked', ip, ts: Date.now() }))
    return new Response(JSON.stringify({ error: 'blocked' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return null
}

// CB-2: Failed Firebase auth tracking.
// After 10 failures within 60 seconds, the IP is blocked for 15 minutes.
// Call this inside a Firebase JWT verification catch block.
export async function trackAuthFailure(req: Request, env: Env): Promise<void> {
  if (!env.CB_KV) return

  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown'
  const failKey = `fail:${ip}`
  const count = parseInt(await env.CB_KV.get(failKey) ?? '0') + 1

  if (count >= 10) {
    await Promise.all([
      env.CB_KV.put(`blocked:${ip}`, '1', { expirationTtl: 900 }),
      env.CB_KV.delete(failKey),
    ])
    console.warn(JSON.stringify({ event: 'auth_circuit_open', ip, failures: count, ts: Date.now() }))
  } else {
    await env.CB_KV.put(failKey, String(count), { expirationTtl: 60 })
  }
}

// CB-3: CLI token minting rate limit.
// Allows at most 5 minted tokens per user per hour.
// Returns a 429 Response if exceeded, null if allowed.
export async function checkCliTokenRateLimit(env: Env, userId: string): Promise<Response | null> {
  if (!env.CB_KV) return null

  const key = `cli-token:${userId}`
  const count = parseInt(await env.CB_KV.get(key) ?? '0') + 1

  if (count > 5) {
    console.warn(JSON.stringify({ event: 'cli_token_rate_limit', userId, count, ts: Date.now() }))
    return new Response(JSON.stringify({ error: 'too_many_requests' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Only write when the request is allowed, so the TTL is not extended on blocked attempts.
  await env.CB_KV.put(key, String(count), { expirationTtl: 3600 })
  return null
}

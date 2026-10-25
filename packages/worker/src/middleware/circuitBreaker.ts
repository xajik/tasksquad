import type { Env } from '../types.js'

// CLI token minting limit: at most 5 minted tokens per user per hour. An hour is longer
// than the Workers Rate Limiting API's longest period, so this one is counted in KV.
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

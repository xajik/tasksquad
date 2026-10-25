import type { Env } from '../types.js'

// Request rate limits backed by the Workers Rate Limiting bindings in wrangler.toml.
// Counters are per client IP and per Cloudflare location, and apply on every hostname
// the worker serves. Requests without CF-Connecting-IP come over a service binding
// (the MCP worker), not the internet, and are not IP-limited: they would all share
// one bucket.

const AUTH_PATHS = new Set(['/auth/cli-token', '/mobile/authorization/codes', '/mobile/authorization/exchange'])

export function clientIp(req: Request): string | null {
  return req.headers.get('CF-Connecting-IP')
}

function tooManyRequests(): Response {
  return new Response(JSON.stringify({ error: 'too_many_requests' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
  })
}

async function exceeded(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false
  const { success } = await limiter.limit({ key })
  return !success
}

// checkRateLimit returns a 429 when the client IP is over the general cap, or over the
// sign-in cap on token endpoints; null otherwise.
export async function checkRateLimit(req: Request, env: Env): Promise<Response | null> {
  const ip = clientIp(req)
  if (!ip || req.method === 'OPTIONS') return null
  if (AUTH_PATHS.has(new URL(req.url).pathname) && await exceeded(env.AUTH_LIMITER, ip)) return tooManyRequests()
  if (await exceeded(env.IP_LIMITER, ip)) return tooManyRequests()
  return null
}

// authFailureResponse counts a failed authentication against the client IP and returns
// the 429 to send instead of the usual 401 once the IP is over the limit.
export async function authFailureResponse(req: Request, env: Env): Promise<Response | null> {
  const ip = clientIp(req)
  if (!ip) return null
  return await exceeded(env.AUTH_FAIL_LIMITER, ip) ? tooManyRequests() : null
}

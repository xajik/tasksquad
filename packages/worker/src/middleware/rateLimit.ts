import type { Env } from '../types.js'

// Request rate limits, keyed by client IP and applied on every hostname the worker
// serves. Requests without CF-Connecting-IP come over a service binding (the MCP
// worker), not the internet, and are not IP-limited: they would all share one bucket.
//
// - All traffic: the Workers Rate Limiting binding (IP_LIMITER). Its counts are cached
//   per machine and only approximate, which is fine for a generous flood cap.
// - Token endpoints and failed authentications: exact counters in the AuthLimiter
//   Durable Object. Only those requests reach it, so ordinary traffic pays nothing.

const WINDOW_MS = 60_000
const AUTH_ENDPOINT_LIMIT = 20 // requests per IP per minute to the paths below
const AUTH_FAILURE_LIMIT = 10  // failed authentications per IP per minute
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

async function overApproximate(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false
  const { success } = await limiter.limit({ key })
  return !success
}

async function overExact(env: Env, bucket: string, ip: string, limit: number): Promise<boolean> {
  if (!env.AUTH_LIMITS) return false
  const stub = env.AUTH_LIMITS.get(env.AUTH_LIMITS.idFromName(`${bucket}:${ip}`))
  const res = await stub.fetch(`https://auth-limiter/hit?limit=${limit}&window=${WINDOW_MS}`, { method: 'POST' })
  if (!res.ok) return false
  const { allowed } = await res.json<{ allowed: boolean }>()
  return !allowed
}

// checkRateLimit returns a 429 when the client IP is over the general cap, or over the
// token-endpoint cap on those paths; null otherwise.
export async function checkRateLimit(req: Request, env: Env): Promise<Response | null> {
  const ip = clientIp(req)
  if (!ip || req.method === 'OPTIONS') return null
  if (AUTH_PATHS.has(new URL(req.url).pathname) && await overExact(env, 'auth', ip, AUTH_ENDPOINT_LIMIT)) return tooManyRequests()
  if (await overApproximate(env.IP_LIMITER, ip)) return tooManyRequests()
  return null
}

// authFailureResponse counts a failed authentication against the client IP and returns
// the 429 to send instead of the usual 401 once the IP is over the limit.
export async function authFailureResponse(req: Request, env: Env): Promise<Response | null> {
  const ip = clientIp(req)
  if (!ip) return null
  return await overExact(env, 'fail', ip, AUTH_FAILURE_LIMIT) ? tooManyRequests() : null
}

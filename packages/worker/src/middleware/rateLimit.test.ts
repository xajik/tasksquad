import { describe, it, expect } from 'vitest'
import { checkRateLimit, authFailureResponse } from './rateLimit.js'
import type { Env } from '../types.js'

// Fake Workers Rate Limiting binding: allows `limit` calls per key, records every key.
function makeLimiter(limit: number) {
  const counts = new Map<string, number>()
  const keys: string[] = []
  const limiter = {
    async limit({ key }: { key: string }) {
      keys.push(key)
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      return { success: n <= limit }
    },
  }
  return { limiter: limiter as unknown as RateLimit, keys }
}

function req(path: string, ip: string | null, method = 'GET'): Request {
  const headers: Record<string, string> = {}
  if (ip) headers['CF-Connecting-IP'] = ip
  return new Request(`https://api.example.com${path}`, { method, headers })
}

describe('checkRateLimit', () => {
  it('passes requests under the general cap and keys them by client IP', async () => {
    const ip = makeLimiter(2)
    const env = { IP_LIMITER: ip.limiter } as unknown as Env
    expect(await checkRateLimit(req('/teams', '1.1.1.1'), env)).toBeNull()
    expect(await checkRateLimit(req('/teams', '1.1.1.1'), env)).toBeNull()
    expect(ip.keys).toEqual(['1.1.1.1', '1.1.1.1'])
  })

  it('answers 429 with Retry-After once an IP is over the general cap', async () => {
    const env = { IP_LIMITER: makeLimiter(1).limiter } as unknown as Env
    await checkRateLimit(req('/teams', '1.1.1.1'), env)
    const res = await checkRateLimit(req('/teams', '1.1.1.1'), env)
    expect(res?.status).toBe(429)
    expect(res?.headers.get('Retry-After')).toBe('60')
    expect(await checkRateLimit(req('/teams', '2.2.2.2'), env)).toBeNull()
  })

  it('applies the strict cap to token endpoints only', async () => {
    const auth = makeLimiter(1)
    const env = { AUTH_LIMITER: auth.limiter, IP_LIMITER: makeLimiter(100).limiter } as unknown as Env
    await checkRateLimit(req('/mobile/authorization/exchange', '1.1.1.1', 'POST'), env)
    expect((await checkRateLimit(req('/mobile/authorization/exchange', '1.1.1.1', 'POST'), env))?.status).toBe(429)
    expect((await checkRateLimit(req('/auth/cli-token', '1.1.1.1', 'POST'), env))?.status).toBe(429)
    expect(await checkRateLimit(req('/teams', '1.1.1.1'), env)).toBeNull()
  })

  it('does not limit service-binding calls without a client IP (the MCP worker)', async () => {
    const ip = makeLimiter(0)
    const env = { IP_LIMITER: ip.limiter, AUTH_LIMITER: makeLimiter(0).limiter } as unknown as Env
    expect(await checkRateLimit(req('/teams', null), env)).toBeNull()
    expect(ip.keys).toEqual([])
  })

  it('does not count CORS preflights', async () => {
    const ip = makeLimiter(0)
    expect(await checkRateLimit(req('/teams', '1.1.1.1', 'OPTIONS'), { IP_LIMITER: ip.limiter } as unknown as Env)).toBeNull()
    expect(ip.keys).toEqual([])
  })

  it('is a no-op when the bindings are absent (local dev, tests)', async () => {
    expect(await checkRateLimit(req('/auth/cli-token', '1.1.1.1', 'POST'), {} as Env)).toBeNull()
  })
})

describe('authFailureResponse', () => {
  it('returns null until the IP exceeds the failure limit, then 429', async () => {
    const env = { AUTH_FAIL_LIMITER: makeLimiter(2).limiter } as unknown as Env
    expect(await authFailureResponse(req('/me', '1.1.1.1'), env)).toBeNull()
    expect(await authFailureResponse(req('/me', '1.1.1.1'), env)).toBeNull()
    expect((await authFailureResponse(req('/me', '1.1.1.1'), env))?.status).toBe(429)
  })

  it('does not count failures without a client IP', async () => {
    const fail = makeLimiter(0)
    expect(await authFailureResponse(req('/me', null), { AUTH_FAIL_LIMITER: fail.limiter } as unknown as Env)).toBeNull()
    expect(fail.keys).toEqual([])
  })
})

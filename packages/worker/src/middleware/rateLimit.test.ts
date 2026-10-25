import { describe, it, expect } from 'vitest'
import { checkRateLimit, authFailureResponse } from './rateLimit.js'
import { AuthLimiter } from './authLimiter.js'
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

// Fake Durable Object namespace running the real AuthLimiter over in-memory storage.
function makeAuthLimits() {
  const objects = new Map<string, AuthLimiter>()
  const names: string[] = []
  const ns = {
    idFromName(name: string) { names.push(name); return name },
    get(id: string) {
      let obj = objects.get(id)
      if (!obj) {
        const store = new Map<string, unknown>()
        const storage = {
          async get(k: string) { return store.get(k) },
          async put(k: string, v: unknown) { store.set(k, v) },
          async setAlarm() {},
          async deleteAll() { store.clear() },
        }
        obj = new AuthLimiter({ storage } as unknown as DurableObjectState)
        objects.set(id, obj)
      }
      const target = obj
      return { fetch: (url: string, init?: RequestInit) => target.fetch(new Request(url, init)) }
    },
  }
  return { ns: ns as unknown as DurableObjectNamespace, names }
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

  it('allows 20 token-endpoint requests per IP per minute, then 429', async () => {
    const limits = makeAuthLimits()
    const env = { AUTH_LIMITS: limits.ns } as unknown as Env
    for (let i = 0; i < 20; i++) {
      expect(await checkRateLimit(req('/mobile/authorization/exchange', '1.1.1.1', 'POST'), env)).toBeNull()
    }
    expect((await checkRateLimit(req('/auth/cli-token', '1.1.1.1', 'POST'), env))?.status).toBe(429)
    expect(await checkRateLimit(req('/auth/cli-token', '2.2.2.2', 'POST'), env)).toBeNull()
    expect(await checkRateLimit(req('/teams', '1.1.1.1'), env)).toBeNull()
    expect(limits.names.every(n => n.startsWith('auth:'))).toBe(true)
  })

  it('does not limit service-binding calls without a client IP (the MCP worker)', async () => {
    const ip = makeLimiter(0)
    const limits = makeAuthLimits()
    const env = { IP_LIMITER: ip.limiter, AUTH_LIMITS: limits.ns } as unknown as Env
    expect(await checkRateLimit(req('/auth/cli-token', null, 'POST'), env)).toBeNull()
    expect(ip.keys).toEqual([])
    expect(limits.names).toEqual([])
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
  it('allows 10 failures per IP per minute, then answers 429', async () => {
    const env = { AUTH_LIMITS: makeAuthLimits().ns } as unknown as Env
    for (let i = 0; i < 10; i++) expect(await authFailureResponse(req('/me', '1.1.1.1'), env)).toBeNull()
    expect((await authFailureResponse(req('/me', '1.1.1.1'), env))?.status).toBe(429)
    expect(await authFailureResponse(req('/me', '2.2.2.2'), env)).toBeNull()
  })

  it('keeps failure and token-endpoint counters separate', async () => {
    const env = { AUTH_LIMITS: makeAuthLimits().ns } as unknown as Env
    for (let i = 0; i < 10; i++) await authFailureResponse(req('/me', '1.1.1.1'), env)
    expect(await checkRateLimit(req('/auth/cli-token', '1.1.1.1', 'POST'), env)).toBeNull()
  })

  it('does not count failures without a client IP', async () => {
    const limits = makeAuthLimits()
    expect(await authFailureResponse(req('/me', null), { AUTH_LIMITS: limits.ns } as unknown as Env)).toBeNull()
    expect(limits.names).toEqual([])
  })
})

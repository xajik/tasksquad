import { describe, it, expect, vi, beforeEach } from 'vitest'
import { checkCircuitBreaker, trackAuthFailure, checkCliTokenRateLimit } from './circuitBreaker.js'
import type { Env } from '../types.js'

function makeKV(store: Record<string, string> = {}): KVNamespace {
  return {
    get: vi.fn(async (key: string) => store[key] ?? null),
    put: vi.fn(async (key: string, value: string) => { store[key] = value }),
    delete: vi.fn(async (key: string) => { delete store[key] }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace
}

function makeReq(ip: string): Request {
  return new Request('https://api.example.com/test', {
    headers: { 'CF-Connecting-IP': ip },
  })
}

function makeEnv(kv?: KVNamespace): Env {
  return { CB_KV: kv } as unknown as Env
}

describe('checkCircuitBreaker', () => {
  it('returns null when CB_KV is not configured', async () => {
    const res = await checkCircuitBreaker(makeReq('1.2.3.4'), makeEnv())
    expect(res).toBeNull()
  })

  it('returns null when IP is not blocked', async () => {
    const kv = makeKV()
    const res = await checkCircuitBreaker(makeReq('1.2.3.4'), makeEnv(kv))
    expect(res).toBeNull()
  })

  it('returns 403 when IP is blocked', async () => {
    const kv = makeKV({ 'blocked:1.2.3.4': '1' })
    const res = await checkCircuitBreaker(makeReq('1.2.3.4'), makeEnv(kv))
    expect(res?.status).toBe(403)
    const body = await res!.json() as { error: string }
    expect(body.error).toBe('blocked')
  })

  it('uses "unknown" as IP when header is absent', async () => {
    const kv = makeKV({ 'blocked:unknown': '1' })
    const res = await checkCircuitBreaker(new Request('https://x.com'), makeEnv(kv))
    expect(res?.status).toBe(403)
  })
})

describe('trackAuthFailure', () => {
  it('is a no-op when CB_KV is not configured', async () => {
    await expect(trackAuthFailure(makeReq('1.2.3.4'), makeEnv())).resolves.toBeUndefined()
  })

  it('increments failure counter below threshold', async () => {
    const store: Record<string, string> = {}
    const kv = makeKV(store)
    await trackAuthFailure(makeReq('1.2.3.4'), makeEnv(kv))
    expect(store['fail:1.2.3.4']).toBe('1')
    await trackAuthFailure(makeReq('1.2.3.4'), makeEnv(kv))
    expect(store['fail:1.2.3.4']).toBe('2')
  })

  it('blocks IP and clears failure counter at threshold (10)', async () => {
    const store: Record<string, string> = { 'fail:5.5.5.5': '9' }
    const kv = makeKV(store)
    await trackAuthFailure(makeReq('5.5.5.5'), makeEnv(kv))
    expect(store['blocked:5.5.5.5']).toBe('1')
    expect(store['fail:5.5.5.5']).toBeUndefined()
  })
})

describe('checkCliTokenRateLimit', () => {
  it('returns null when CB_KV is not configured', async () => {
    const res = await checkCliTokenRateLimit(makeEnv(), 'user-1')
    expect(res).toBeNull()
  })

  it('allows the first 5 requests and stores incrementing count', async () => {
    const store: Record<string, string> = {}
    const kv = makeKV(store)
    const env = makeEnv(kv)

    for (let i = 1; i <= 5; i++) {
      const res = await checkCliTokenRateLimit(env, 'user-1')
      expect(res).toBeNull()
      expect(store['cli-token:user-1']).toBe(String(i))
    }
  })

  it('returns 429 on the 6th request', async () => {
    const store: Record<string, string> = { 'cli-token:user-1': '5' }
    const kv = makeKV(store)
    const res = await checkCliTokenRateLimit(makeEnv(kv), 'user-1')
    expect(res?.status).toBe(429)
    const body = await res!.json() as { error: string }
    expect(body.error).toBe('too_many_requests')
  })

  it('does not write to KV when rate limit is exceeded (no TTL extension)', async () => {
    const store: Record<string, string> = { 'cli-token:user-1': '5' }
    const kv = makeKV(store)
    await checkCliTokenRateLimit(makeEnv(kv), 'user-1')
    expect(kv.put).not.toHaveBeenCalled()
  })
})

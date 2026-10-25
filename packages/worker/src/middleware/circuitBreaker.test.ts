import { describe, it, expect, vi } from 'vitest'
import { checkCliTokenRateLimit } from './circuitBreaker.js'
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

function makeEnv(kv?: KVNamespace): Env {
  return { CB_KV: kv } as unknown as Env
}

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

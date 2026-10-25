import { describe, it, expect } from 'vitest'
import { hit } from './authLimiter.js'

describe('hit', () => {
  it('starts a window on the first request', () => {
    expect(hit(undefined, 1000, 60_000, 2)).toEqual({ window: { start: 1000, count: 1 }, allowed: true })
  })

  it('counts within the window and refuses past the limit', () => {
    let w = hit(undefined, 0, 60_000, 2).window
    const second = hit(w, 10, 60_000, 2)
    expect(second.allowed).toBe(true)
    w = second.window
    expect(hit(w, 20, 60_000, 2)).toEqual({ window: { start: 0, count: 3 }, allowed: false })
  })

  it('resets once the window has passed', () => {
    const full = { start: 0, count: 50 }
    expect(hit(full, 60_000, 60_000, 2)).toEqual({ window: { start: 60_000, count: 1 }, allowed: true })
  })
})

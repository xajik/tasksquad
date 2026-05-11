import { describe, it, expect } from 'vitest'
import { DefaultSupervisorStrategy } from './supervisor.js'

// ── DefaultSupervisorStrategy.parseResponse ────────────────────────────────────
// Pure function — no mocking needed.

const strategy = new DefaultSupervisorStrategy()

describe('parseResponse — exact JSON', () => {
  it('returns yes for approved: true', () => {
    expect(strategy.parseResponse('{"approved": true, "explanation": "Looks good."}')).toBe('yes')
  })

  it('returns no for approved: false', () => {
    expect(strategy.parseResponse('{"approved": false, "explanation": "Missing section X."}')).toBe('no')
  })

  it('works without explanation field (still valid)', () => {
    expect(strategy.parseResponse('{"approved": true}')).toBe('yes')
  })
})

describe('parseResponse — JSON wrapped in prose', () => {
  it('extracts JSON from surrounding prose', () => {
    const body = 'After reviewing the output I believe {"approved": true, "explanation": "All done."} is correct.'
    expect(strategy.parseResponse(body)).toBe('yes')
  })

  it('extracts multiline JSON from prose', () => {
    const body = `Here is my verdict:\n{\n  "approved": false,\n  "explanation": "Incomplete."\n}\nHope that helps.`
    expect(strategy.parseResponse(body)).toBe('no')
  })
})

describe('parseResponse — malformed input', () => {
  it('returns null for empty string', () => {
    expect(strategy.parseResponse('')).toBeNull()
  })

  it('returns null for plain prose with no JSON', () => {
    expect(strategy.parseResponse('Yes, requirements are met.')).toBeNull()
  })

  it('returns null for invalid JSON object', () => {
    expect(strategy.parseResponse('{not valid json}')).toBeNull()
  })

  it('returns null when approved is a string not boolean', () => {
    expect(strategy.parseResponse('{"approved": "yes", "explanation": "ok"}')).toBeNull()
  })

  it('returns null when approved key is missing (old meets_requirements format)', () => {
    expect(strategy.parseResponse('{"meets_requirements": true}')).toBeNull()
  })

  it('returns null when value is a number', () => {
    expect(strategy.parseResponse('{"approved": 1}')).toBeNull()
  })
})

// ── DefaultSupervisorStrategy.shouldVerify ────────────────────────────────────

describe('shouldVerify', () => {
  it('returns false for all phases in v1 (opt-in not yet wired)', () => {
    // @ts-expect-error — minimal PhaseRow stub
    expect(strategy.shouldVerify({ id: 'p1' })).toBe(false)
  })
})

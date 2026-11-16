import { describe, it, expect } from 'vitest'
import { parseResult, verifyGoal, policy } from './contracts.js'

describe('graph response contracts', () => {
  const valid = { subgoals: [{ title: 'Cafe\u0301', description: '', body: 'observe', necessity_confidence: .7 }] }
  it('accepts a whole JSON response or one fence, normalizing NFC', () => {
    const parsed = parseResult('decompose', `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``)
    expect((parsed.subgoals as { title: string }[])[0].title).toBe('Café')
  })
  it('rejects prose extraction, unknown keys, invalid scores and oversized Unicode content', () => {
    expect(() => parseResult('decompose', `Here: ${JSON.stringify(valid)}`)).toThrow()
    expect(() => parseResult('decompose', JSON.stringify({ ...valid, publish: true }))).toThrow()
    expect(() => parseResult('decompose', JSON.stringify({ subgoals: [{ ...valid.subgoals[0], necessity_confidence: 2 }] }))).toThrow()
    expect(() => parseResult('decompose', JSON.stringify({ subgoals: [{ ...valid.subgoals[0], description: '😀'.repeat(300) }] }))).toThrow()
  })
  it('requires explicit null for unknown grading scores', () => {
    expect(parseResult('grade', '{"local_score":null,"evidence_ids":[],"reason":"unknown"}').local_score).toBeNull()
    expect(() => parseResult('grade', '{}')).toThrow()
  })
})

describe('goal verification', () => {
  const rule = { op: 'AND' as const, predicates: ['metric'], scope: 'production' }
  const observation = { predicate: 'metric', value: 'true' as const, scope: 'production', expires_at: 100 }
  it('needs fresh scoped evidence and rejects empty rules', () => {
    expect(verifyGoal(rule, [observation], 50)).toBe('true')
    expect(verifyGoal(rule, [observation], 100)).toBe('unknown')
    expect(verifyGoal({ ...rule, scope: 'test' }, [observation], 50)).toBe('unknown')
    expect(verifyGoal({ ...rule, predicates: [] }, [observation], 50)).toBe('unknown')
  })
  it('treats conflicting evidence as unknown', () => {
    expect(verifyGoal(rule, [observation, { ...observation, value: 'false' }], 50)).toBe('unknown')
  })
  it('defaults to review and one execution slot with finite budgets', () => {
    expect(policy({ agents: ['a'], grader: 'g', decomposer: 'd' })).toMatchObject({ review: true, capacity: 1, max_attempts: 3 })
    expect(() => policy({ agents: ['a'], grader: 'g', decomposer: 'd', cost_budget: Infinity })).toThrow()
  })
})

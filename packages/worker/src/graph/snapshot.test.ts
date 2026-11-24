import { describe, it, expect } from 'vitest'
import { slimAssignment } from './snapshot.js'
import type { Assignment } from './store.js'

const assignment = (input: unknown) => ({ id: 'a', input: JSON.stringify(input), template: 'big' }) as unknown as Assignment

describe('slim assignment', () => {
  it('keeps the context the inbox review summaries need and drops the rest', () => {
    const slim = slimAssignment(
      assignment({
        title: 'T',
        operation: 'op',
        goals: [{ id: 'g', title: 'Goal' }],
        plan: { title: 'P', projected_impact: [{ goal_id: 'g', delta: 0.2 }], steps: ['x'] },
        secret_context: 'long'
      })
    )
    expect(slim).not.toHaveProperty('template')
    expect(JSON.parse(String(slim.input))).toEqual({
      title: 'T',
      operation: 'op',
      goals: [{ id: 'g', title: 'Goal' }],
      plan: { title: 'P', projected_impact: [{ goal_id: 'g', delta: 0.2 }] }
    })
  })
  it('passes non-JSON input through unchanged', () => {
    expect(slimAssignment({ id: 'a', input: 'not json' } as unknown as Assignment).input).toBe('not json')
  })
})

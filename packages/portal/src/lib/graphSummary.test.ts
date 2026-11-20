import { describe, it, expect } from 'vitest'
import { summarizeResult } from './graphSummary'

describe('summarizeResult', () => {
  it('summarises decomposition without raw JSON', () => {
    const s = summarizeResult('decompose', JSON.stringify({ subgoals: [{ title: 'A', necessity_confidence: 0.9 }, { title: 'B', necessity_confidence: 0.4 }] }))!
    expect(s.headline).toContain('2 subgoals')
    expect(s.rows[0]).toEqual({ label: 'Subgoal 1 · necessity 0.90', value: 'A' })
  })
  it('lists execution evidence and warns that rejection does not roll back', () => {
    const s = summarizeResult('execute', JSON.stringify({ outcome: 'complete', title: 't', description: 'd', evidence: [{ predicate: 'p', value: 'true', resource_id: 'r1' }] }))!
    expect(s.rows.some((r) => r.label === 'Evidence · p' && r.value.includes('r1'))).toBe(true)
    expect(s.consequence).toContain('not rolled back')
  })
  it('returns null for unparseable or unknown results', () => {
    expect(summarizeResult('plan', 'nope')).toBeNull()
    expect(summarizeResult('mystery', '{}')).toBeNull()
  })
  it('distinguishes plan alignment from verified goal achievement', () => {
    const summary = summarizeResult('project', JSON.stringify({ goal_score: 0.6, evidence_ids: [], decomposition_feedback: ['Add analytics'], reason: 'No sales evidence' }), 'decomposition_review')!
    expect(summary.headline).toContain('Decomposition alignment')
    expect(summary.consequence).toContain('does not measure sales')
  })
})

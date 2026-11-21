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
  it('shows actual versus projected impact per goal and marks the most moved goal', () => {
    const summary = summarizeResult(
      'project',
      JSON.stringify({
        goal_score: 0.05,
        reason: 'r',
        primary_goal_id: 'ms',
        goal_impacts: [
          { goal_id: 'root', actual: 0.05, predicates: ['A'], evidence_ids: ['e'] },
          { goal_id: 'ms', actual: 0.5, predicates: ['B', 'C'], evidence_ids: ['e'] }
        ]
      }),
      undefined,
      {
        goals: [{ id: 'root', title: 'Root' }, { id: 'ms', title: 'Supply chain' }],
        plan: { projected_impact: [{ goal_id: 'ms', delta: 0.4 }] }
      }
    )!
    expect(summary.rows).toContainEqual({
      label: 'Most moved · Supply chain',
      value: 'actual 0.50 vs projected 0.40 · 2 predicates'
    })
    expect(summary.rows).toContainEqual({ label: 'Root', value: 'actual 0.05 · 1 predicate' })
  })
})

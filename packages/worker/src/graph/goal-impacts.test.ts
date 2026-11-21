import { describe, expect, it } from 'vitest'
import { assertGoalImpacts, type GoalScope } from './engine'

const goals: GoalScope[] = [
  { id: 'root', kind: 'goal', title: 'Root', body: 'b', predicates: ['P1', 'P2', 'P3'] },
  { id: 'ms', kind: 'milestone', title: 'Milestone', body: 'owns P2', predicates: ['P2'] }
]
const original = () =>
  ({ role: 'project', input: JSON.stringify({ goals, evidence: [{ id: 'e1' }] }) }) as never

describe('assertGoalImpacts', () => {
  it('accepts per-goal impact backed by predicates and evidence', () => {
    expect(() =>
      assertGoalImpacts(original(), {
        goal_impacts: [{ goal_id: 'ms', actual: 1, predicates: ['P2'], evidence_ids: ['e1'] }],
        primary_goal_id: 'ms'
      })
    ).not.toThrow()
  })

  it('skips contexts that predate the goal hierarchy', () => {
    expect(() =>
      assertGoalImpacts({ role: 'project', input: '{}' } as never, { goal_impacts: [{ goal_id: 'x' }] })
    ).not.toThrow()
  })

  it.each([
    [
      'an unsupplied goal',
      { goal_impacts: [{ goal_id: 'x', actual: 0, predicates: [], evidence_ids: [] }], primary_goal_id: 'x' }
    ],
    [
      'a predicate the goal does not own',
      { goal_impacts: [{ goal_id: 'ms', actual: 1, predicates: ['P1'], evidence_ids: ['e1'] }], primary_goal_id: 'ms' }
    ],
    [
      'impact without evidence',
      { goal_impacts: [{ goal_id: 'ms', actual: 0.5, predicates: ['P2'], evidence_ids: [] }], primary_goal_id: 'ms' }
    ],
    [
      'unsupplied evidence',
      { goal_impacts: [{ goal_id: 'ms', actual: 0.5, predicates: ['P2'], evidence_ids: ['zz'] }], primary_goal_id: 'ms' }
    ],
    [
      'a primary goal that is not listed',
      { goal_impacts: [{ goal_id: 'ms', actual: 0, predicates: [], evidence_ids: [] }], primary_goal_id: 'root' }
    ]
  ])('rejects %s', (_, d) => {
    expect(() => assertGoalImpacts(original(), d)).toThrow()
  })
})

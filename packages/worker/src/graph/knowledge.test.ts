import { describe, expect, it } from 'vitest'
import { ownerDecisions } from './knowledge.js'

describe('owner decisions', () => {
  const answer = (received: number, answers: string, scope = 'interviews') => ({
    scope, received, reply: 'approval_response:\n  title: Pricing\n  answers:\n' + answers
  })
  it('folds repeated and superseded fields while preserving purpose, scope and untouched fields', () => {
    const decisions = ownerDecisions([
      answer(4, '    prices: "$49/$79/$99"'),
      answer(3, '    prices: "$49/$79/$99"'),
      answer(2, '    prices: "$79 final"', 'production'),
      answer(1, '    prices: "$45/$65/$89"\n    market: USA')
    ]).join('\n')
    expect(decisions.split('$49/$79/$99')).toHaveLength(2)
    expect(decisions).toContain('$79 final')
    expect(decisions).toContain('market: USA')
    expect(decisions).not.toContain('$45/$65/$89')
  })
  it('keeps an older relevant form when unrelated recent replies fill the summary budget', () => {
    const unrelated = Array.from({ length: 100 }, (_, i) => ({
      received: 200 - i, scope: 'analytics', reply: 'Screen layout change ' + i
    }))
    const summary = ownerDecisions([...unrelated, answer(1, '    prices: "$49/$79/$99"\n    approver: owner')], 220,
      'Recruit buyers for interviews, using approved prices and approver')
    expect(summary.join(' ')).toContain('prices: $49/$79/$99 | approver: owner')
    expect(summary.join(' ')).toContain('omitted')
  })
  it('keeps whole answers and marks omissions without reviving a superseded value', () => {
    const summary = ownerDecisions([answer(2, '    prices: ' + 'x'.repeat(1000)), answer(1, '    prices: OLD')], 100)
    expect(summary).toEqual(['[additional owner answers omitted]'])
  })
})

import { describe, expect, it } from 'vitest'
import { resolveEvidenceIds } from './engine/accept/review.js'

const input = {
  result: { evidence: [{ id: 'ev-faq', predicate: 'A pricing FAQ answer is recorded' }] },
  // Acceptance minted a fresh row id because an earlier execution already used the label "ev-faq".
  evidence: [{ id: '01M89Z0NX555Q2Y3V78WN8DK3P', predicate: 'A pricing FAQ answer is recorded' }]
}

describe('resolveEvidenceIds', () => {
  it('accepts stored row ids as they are', () => {
    expect(resolveEvidenceIds(input, ['01M89Z0NX555Q2Y3V78WN8DK3P'], 'nope')).toEqual(['01M89Z0NX555Q2Y3V78WN8DK3P'])
  })

  it("resolves the executor's own label to the stored row, without duplicating a row cited both ways", () => {
    expect(resolveEvidenceIds(input, ['ev-faq'], 'nope')).toEqual(['01M89Z0NX555Q2Y3V78WN8DK3P'])
    expect(resolveEvidenceIds(input, ['ev-faq', '01M89Z0NX555Q2Y3V78WN8DK3P'], 'nope')).toEqual(['01M89Z0NX555Q2Y3V78WN8DK3P'])
  })

  it('still rejects ids that are neither a stored row nor a label from this result', () => {
    expect(() => resolveEvidenceIds(input, ['made-up'], 'unsupplied')).toThrow('unsupplied')
    expect(() => resolveEvidenceIds({ ...input, evidence: [] }, ['ev-faq'], 'unsupplied')).toThrow('unsupplied')
  })
})

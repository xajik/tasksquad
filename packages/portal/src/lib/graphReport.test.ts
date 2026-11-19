import { describe, expect, it } from 'vitest'
import { summarize } from './graphReport'

describe('summarize', () => {
  it('reads the reason from JSON and YAML replies', () => {
    expect(summarize('{"decision":"distinct","reason":"No overlap with siblings"}')).toBe('No overlap with siblings')
    expect(summarize('decision: "blocked"\nreason: "Approvals missing"\n')).toBe('Approvals missing')
  })
  it('truncates long text', () => {
    expect(summarize('x'.repeat(500), 50).length).toBe(50)
  })
})

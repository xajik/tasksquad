import { describe, expect, it } from 'vitest'
import { capContext, prompt, toYaml } from './contracts.js'

describe('graph prompt yaml', () => {
  it('renders nested data as block yaml', () => {
    expect(toYaml({ a: 'plain text', b: ['x', { c: 1 }], d: [], e: 'true', f: 'a: b' })).toBe(
      'a: plain text\nb:\n  - x\n  -\n    c: 1\nd: []\ne: "true"\nf: "a: b"'
    )
  })
  it('caps oversized context', () => {
    const big = { body: 'x'.repeat(20000), other: 'y'.repeat(20000) }
    expect(capContext(big, 3000).length).toBeLessThanOrEqual(3000)
  })
  it('keeps merge prompts small', () => {
    const p = prompt('merge', { candidate: { body: 'z'.repeat(9000) }, existing_hierarchy: [{ body: 'q'.repeat(9000) }] })
    expect(p.length).toBeLessThan(7500)
    expect(p).toContain('context:')
  })
})

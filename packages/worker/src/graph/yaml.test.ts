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
    expect(p.length).toBeLessThan(17500)
    expect(p).toContain('context:')
  })
})

describe('skill identities', () => {
  it('strips frontmatter, bounds length and replaces the instruction', async () => {
    const { skillInstruction } = await import('./contracts.js')
    expect(skillInstruction('---\nname: tsq-graph-grade\n---\nYou are the grader.')).toBe('You are the grader.')
    expect(skillInstruction('x'.repeat(5000)).length).toBeLessThan(1600)
    expect(prompt('grade', {}, undefined, 'You are the grader.')).toMatch(/^You are the grader\./)
  })
})

import { parseResult } from './contracts.js'
describe('yaml replies', () => {
  it('accepts a YAML reply and a JSON reply', () => {
    const y = 'decision: distinct\nequivalent_node_id: null\nreason: "ok: fine"\n'
    expect(parseResult('merge', y)).toEqual({ decision: 'distinct', equivalent_node_id: null, reason: 'ok: fine' })
    expect(parseResult('merge', '```yaml\n' + y + '```').decision).toBe('distinct')
    expect(parseResult('merge', '{"decision":"reject","equivalent_node_id":null,"reason":"x"}').decision).toBe('reject')
  })
  it('rejects prose', () => {
    expect(() => parseResult('merge', "I can't complete this retry")).toThrow()
  })
})

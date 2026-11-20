import { describe, expect, it } from 'vitest'
import { formatBody } from './formatBody'

describe('formatBody', () => {
  it('leaves ordinary text alone', () => {
    expect(formatBody('Done. Tests pass.')).toBeNull()
    expect(formatBody('[1,2,3]')).toBeNull()
  })
  it('turns a JSON or YAML reply into a headline and rows', () => {
    const f = formatBody('{"decision":"blocked","reason":"Approvals missing","checks":["a","b"],"nested":{"x":1}}')!
    expect(f.headline).toBe('Approvals missing')
    expect(f.rows.map((r) => r.label)).toEqual(['Decision', 'Checks', 'Nested'])
    expect(f.rows[1].value).toBe('• a\n• b')
    expect(formatBody('title: "Plan"\nstatus: ok')!.headline).toBe('Plan')
  })
})

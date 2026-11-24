import { describe, it, expect } from 'vitest'
import { fingerprint, jaccard, tokens, normalizeText, actionText, AUTO_DUPLICATE } from './dedup.js'

const base = {
  from_id: 'n1',
  title: 'Add retry to uploader',
  resource_versions: ['r2', 'r1'],
  effects: ['Uploader retries failed chunks'],
  steps: ['Edit uploader.ts', 'Run tests']
}

describe('graph dedup primitives', () => {
  it('normalizes wording noise out of the fingerprint', async () => {
    const reworded = { ...base, resource_versions: ['r1', 'r2'], effects: ['uploader retries failed chunks!'], title: 'Different title' }
    expect(await fingerprint(reworded)).toBe(await fingerprint(base))
  })
  it('separates different sources, resources and effects', async () => {
    const f = await fingerprint(base)
    expect(await fingerprint({ ...base, from_id: 'n2' })).not.toBe(f)
    expect(await fingerprint({ ...base, resource_versions: ['r1'] })).not.toBe(f)
    expect(await fingerprint({ ...base, effects: ['Uploader logs failures'] })).not.toBe(f)
  })
  it('scores rewordings above the automatic threshold and unrelated actions below it', () => {
    const reworded = tokens(actionText({ ...base, title: 'Uploader: add retries', effects: ['Failed chunks are retried by uploader'] }))
    expect(jaccard(tokens(actionText(base)), reworded)).toBeGreaterThan(0.45)
    const other = tokens(actionText({ title: 'Rotate signing keys', effects: ['New key published'], steps: ['Run rotate script'] }))
    expect(jaccard(tokens(actionText(base)), other)).toBeLessThan(AUTO_DUPLICATE)
    expect(jaccard(tokens(actionText(base)), tokens(actionText(base)))).toBe(1)
  })
  it('normalizes case, punctuation and whitespace', () => {
    expect(normalizeText('  Foo—BAR,  baz! ')).toBe('foo bar baz')
  })
})

import { describe, expect, it } from 'vitest'
import { PUBLIC_HOST_HEADER, publicOrigin } from './origin.js'

const env = { PUBLIC_URL: 'https://mcp.test', ALIAS_ORIGINS: 'https://tasksquad.ai, https://alias.test' }
const req = (host?: string) => new Request('https://mcp.test/mcp', host ? { headers: { [PUBLIC_HOST_HEADER]: host } } : {})

describe('publicOrigin', () => {
  it('defaults to PUBLIC_URL', () => {
    expect(publicOrigin(req(), env)).toBe('https://mcp.test')
  })

  it('honours listed aliases only', () => {
    expect(publicOrigin(req('tasksquad.ai'), env)).toBe('https://tasksquad.ai')
    expect(publicOrigin(req('TaskSquad.ai'), env)).toBe('https://tasksquad.ai')
    expect(publicOrigin(req('evil.test'), env)).toBe('https://mcp.test')
    expect(publicOrigin(req('tasksquad.ai'), { PUBLIC_URL: 'https://mcp.test' })).toBe('https://mcp.test')
  })
})

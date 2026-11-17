import { describe, expect, it } from 'vitest'
import { selectLocalGraphToken } from './localGraph'

describe('local graph development session', () => {
  const token = `tsq_cli_${'a'.repeat(64)}`
  it('uses a seeded token only with local UI and API in development', () => {
    expect(selectLocalGraphToken(true, 'localhost', 'http://127.0.0.1:8788', token)).toBe(token)
    expect(selectLocalGraphToken(false, 'localhost', 'http://127.0.0.1:8788', token)).toBeNull()
    expect(selectLocalGraphToken(true, 'tasksquad.ai', 'http://127.0.0.1:8788', token)).toBeNull()
    expect(selectLocalGraphToken(true, 'localhost', 'https://api.tasksquad.ai', token)).toBeNull()
    expect(selectLocalGraphToken(true, 'localhost', 'http://localhost.evil.test:8788', token)).toBeNull()
    expect(selectLocalGraphToken(true, 'localhost', 'http://127.0.0.1:8788', 'invalid')).toBeNull()
  })
})

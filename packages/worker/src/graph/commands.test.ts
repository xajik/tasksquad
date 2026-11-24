import { describe, it, expect } from 'vitest'
import { COMMANDS_WHEN_DISABLED } from './commands.js'

describe('commands allowed while dispatch is disabled', () => {
  it('lets owners recover or cancel a standalone review', () => {
    expect(COMMANDS_WHEN_DISABLED).toContain('retry_review')
    expect(COMMANDS_WHEN_DISABLED).toContain('cancel_review')
  })
})

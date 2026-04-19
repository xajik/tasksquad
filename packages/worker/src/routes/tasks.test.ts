import { describe, it, expect } from 'vitest'
import { MessageType } from '../statuses.js'

// ── MessageType values ────────────────────────────────────────────────────────

describe('MessageType', () => {
  it('has inbox type', () => {
    expect(MessageType.Inbox).toBe('inbox')
  })

  it('has conveyor type', () => {
    expect(MessageType.Conveyor).toBe('conveyor')
  })

  it('preserves all pre-existing types', () => {
    expect(MessageType.NoteToInbox).toBe('note-to-inbox')
    expect(MessageType.NoteCritique).toBe('note-critique')
    expect(MessageType.Thinking).toBe('thinking')
    expect(MessageType.ToolCall).toBe('tool_call')
    expect(MessageType.ToolResult).toBe('tool_result')
    expect(MessageType.Output).toBe('output')
    expect(MessageType.PermissionRequest).toBe('permission_request')
  })
})

// ── Default close_steps logic (mirrors tasks.ts:create) ──────────────────────

function resolveCloseSteps(explicit?: string[]): string[] {
  return explicit?.length
    ? explicit
    : ['/tsq-end-session-learning', '/tsq-cleanup']
}

describe('inbox default close_steps', () => {
  it('returns learning + cleanup when caller omits close_steps', () => {
    expect(resolveCloseSteps(undefined)).toEqual([
      '/tsq-end-session-learning',
      '/tsq-cleanup',
    ])
  })

  it('returns learning + cleanup when caller passes empty array', () => {
    expect(resolveCloseSteps([])).toEqual([
      '/tsq-end-session-learning',
      '/tsq-cleanup',
    ])
  })

  it('respects explicit close_steps from caller', () => {
    expect(resolveCloseSteps(['/custom-step'])).toEqual(['/custom-step'])
  })

  it('respects multiple explicit steps', () => {
    expect(resolveCloseSteps(['/step-a', '/step-b'])).toEqual(['/step-a', '/step-b'])
  })
})

// ── Note/conveyor default close_steps (cleanup only) ─────────────────────────

const NOTE_CONVEYOR_DEFAULTS = ['/tsq-cleanup']

describe('note and conveyor default close_steps', () => {
  it('note-to-inbox default contains only cleanup', () => {
    expect(NOTE_CONVEYOR_DEFAULTS).toEqual(['/tsq-cleanup'])
  })

  it('note-critique default contains only cleanup', () => {
    expect(NOTE_CONVEYOR_DEFAULTS).toEqual(['/tsq-cleanup'])
  })

  it('conveyor default contains only cleanup', () => {
    expect(NOTE_CONVEYOR_DEFAULTS).toEqual(['/tsq-cleanup'])
  })

  it('cleanup step is the tsq-cleanup skill', () => {
    expect(NOTE_CONVEYOR_DEFAULTS[0]).toBe('/tsq-cleanup')
  })
})

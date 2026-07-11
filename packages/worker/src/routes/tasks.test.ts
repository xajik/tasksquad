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

// ── Default close_steps logic (mirrors tasks.ts:create + defaultCloseSteps) ──
// Since 0039_memory.sql, the default (caller omits close_steps) is gated by the
// team's memory_enabled flag — /tsq-end-session-memory is only injected when set.
// Explicit close_steps from the caller always win, same as before.

function resolveCloseSteps(explicit: string[] | undefined, memoryEnabled: boolean): string[] {
  if (explicit?.length) return explicit
  const steps = ['/tsq-end-session-learning']
  if (memoryEnabled) steps.push('/tsq-end-session-memory')
  steps.push('/tsq-cleanup')
  return steps
}

describe('inbox default close_steps', () => {
  it('returns learning + memory + cleanup when memory is enabled and caller omits close_steps', () => {
    expect(resolveCloseSteps(undefined, true)).toEqual([
      '/tsq-end-session-learning',
      '/tsq-end-session-memory',
      '/tsq-cleanup',
    ])
  })

  it('returns learning + cleanup (no memory step) when memory is disabled', () => {
    expect(resolveCloseSteps(undefined, false)).toEqual([
      '/tsq-end-session-learning',
      '/tsq-cleanup',
    ])
  })

  it('returns learning + memory + cleanup when caller passes empty array and memory is enabled', () => {
    expect(resolveCloseSteps([], true)).toEqual([
      '/tsq-end-session-learning',
      '/tsq-end-session-memory',
      '/tsq-cleanup',
    ])
  })

  it('respects explicit close_steps from caller regardless of memory_enabled', () => {
    expect(resolveCloseSteps(['/custom-step'], true)).toEqual(['/custom-step'])
    expect(resolveCloseSteps(['/custom-step'], false)).toEqual(['/custom-step'])
  })

  it('respects multiple explicit steps', () => {
    expect(resolveCloseSteps(['/step-a', '/step-b'], true)).toEqual(['/step-a', '/step-b'])
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

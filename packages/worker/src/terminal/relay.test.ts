import { describe, it, expect } from 'vitest'

// ── Relay connection identity ─────────────────────────────────────────────────
// The relay identifies the daemon by the X-TSQ-Agent request header.

function classifyConnection(headers: Record<string, string>): 'daemon' | 'viewer' {
  return 'X-TSQ-Agent' in headers ? 'daemon' : 'viewer'
}

describe('relay connection identity', () => {
  it('classifies daemon by X-TSQ-Agent header', () => {
    expect(classifyConnection({ 'X-TSQ-Agent': 'token123' })).toBe('daemon')
  })

  it('classifies browser viewers by absence of X-TSQ-Agent header', () => {
    expect(classifyConnection({})).toBe('viewer')
    expect(classifyConnection({ Authorization: 'Bearer xyz' })).toBe('viewer')
  })
})

// ── Relay frame routing ───────────────────────────────────────────────────────
// Daemon binary frames: fan-out to all viewers.
// Browser binary control frames (JSON-encoded): forward to daemon only.
// Text frames from either side: discard.

function shouldFanOutToViewers(isDaemon: boolean, data: ArrayBuffer | string): boolean {
  return isDaemon && data instanceof ArrayBuffer
}

function shouldForwardToDaemon(isDaemon: boolean, data: ArrayBuffer | string): boolean {
  if (typeof data === 'string') return false // text frames discarded
  return !isDaemon
}

describe('relay frame routing — daemon → viewers (PTY output)', () => {
  const ptyChunk = new ArrayBuffer(16)

  it('fans out PTY output to all viewers', () => {
    expect(shouldFanOutToViewers(true, ptyChunk)).toBe(true)
  })

  it('does not forward PTY output back to the daemon', () => {
    expect(shouldForwardToDaemon(true, ptyChunk)).toBe(false)
  })

  it('discards text frames from daemon', () => {
    expect(shouldFanOutToViewers(true, '__ping__')).toBe(false)
    expect(shouldFanOutToViewers(true, 'any text')).toBe(false)
  })
})

describe('relay frame routing — browser → daemon (stdin / resize)', () => {
  const controlFrame = new ArrayBuffer(32) // JSON-encoded control frame sent as binary

  it('forwards browser binary frames to daemon', () => {
    expect(shouldForwardToDaemon(false, controlFrame)).toBe(true)
  })

  it('does not fan-out browser frames to other viewers', () => {
    expect(shouldFanOutToViewers(false, controlFrame)).toBe(false)
  })

  it('discards text frames from browser', () => {
    expect(shouldForwardToDaemon(false, '__ping__')).toBe(false)
    expect(shouldForwardToDaemon(false, 'any text')).toBe(false)
  })
})

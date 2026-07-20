import { describe, it, expect } from 'vitest'
import { appendCapped, shouldReplay, BUFFER_CAP_BYTES } from './relay.js'

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

// ── Output buffer (for replaying to a reconnecting viewer) ────────────────────

describe('appendCapped', () => {
  it('appends a chunk onto the existing buffer', () => {
    const buffer = new Uint8Array([1, 2, 3])
    const chunk = new Uint8Array([4, 5])
    expect(Array.from(appendCapped(buffer, chunk, 10))).toEqual([1, 2, 3, 4, 5])
  })

  it('truncates from the front once the cap is exceeded, keeping the newest bytes', () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5])
    const chunk = new Uint8Array([6, 7, 8])
    expect(Array.from(appendCapped(buffer, chunk, 5))).toEqual([4, 5, 6, 7, 8])
  })

  it('never returns more than the cap even for a single oversized chunk', () => {
    const chunk = new Uint8Array(20).fill(9)
    expect(appendCapped(new Uint8Array(0), chunk, 5).length).toBe(5)
  })

  it('production cap is 64 KiB', () => {
    expect(BUFFER_CAP_BYTES).toBe(64 * 1024)
  })
})

describe('shouldReplay', () => {
  it('replays when the viewer explicitly requests it and a buffer exists', () => {
    expect(shouldReplay('1', 128)).toBe(true)
  })

  it('does not replay on a same-session reconnect (replay=0) — the client already has this content', () => {
    expect(shouldReplay('0', 128)).toBe(false)
  })

  it('does not replay when the param is absent (older client, or daemon connection)', () => {
    expect(shouldReplay(null, 128)).toBe(false)
  })

  it('does not replay an empty buffer even if requested', () => {
    expect(shouldReplay('1', 0)).toBe(false)
  })
})

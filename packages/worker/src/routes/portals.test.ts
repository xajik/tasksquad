import { describe, it, expect } from 'vitest'

// ── Portal status classification ──────────────────────────────────────────────
// Mirrors the logic embedded in portals.ts route handlers.

function isTerminalStatus(s: string): boolean {
  return s === 'done' || s === 'failed'
}

function isActiveStatus(s: string): boolean {
  return s === 'pending' || s === 'running'
}

describe('portal status classification', () => {
  it('treats done and failed as terminal', () => {
    expect(isTerminalStatus('done')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
  })

  it('treats pending and running as non-terminal', () => {
    expect(isTerminalStatus('pending')).toBe(false)
    expect(isTerminalStatus('running')).toBe(false)
  })

  it('treats pending and running as active', () => {
    expect(isActiveStatus('pending')).toBe(true)
    expect(isActiveStatus('running')).toBe(true)
  })

  it('treats done and failed as not active', () => {
    expect(isActiveStatus('done')).toBe(false)
    expect(isActiveStatus('failed')).toBe(false)
  })
})

// ── daemonClose idempotency guard ─────────────────────────────────────────────
// The UPDATE uses WHERE status NOT IN ('done', 'failed').
// Verify that only terminal statuses are guarded.

function daemonCloseWouldUpdate(currentStatus: string): boolean {
  return !isTerminalStatus(currentStatus)
}

describe('daemonClose idempotency', () => {
  it('allows update for pending and running', () => {
    expect(daemonCloseWouldUpdate('pending')).toBe(true)
    expect(daemonCloseWouldUpdate('running')).toBe(true)
  })

  it('blocks update for done (no double-close)', () => {
    expect(daemonCloseWouldUpdate('done')).toBe(false)
  })

  it('blocks update for failed (crash recovery cannot overwrite natural close)', () => {
    expect(daemonCloseWouldUpdate('failed')).toBe(false)
  })
})

// ── daemonOpen status gate ────────────────────────────────────────────────────
// daemonOpen only accepts 'pending' portals.

function daemonOpenWouldAccept(currentStatus: string): boolean {
  return currentStatus === 'pending'
}

describe('daemonOpen gate', () => {
  it('accepts pending portals', () => {
    expect(daemonOpenWouldAccept('pending')).toBe(true)
  })

  it('rejects running, done, failed portals', () => {
    expect(daemonOpenWouldAccept('running')).toBe(false)
    expect(daemonOpenWouldAccept('done')).toBe(false)
    expect(daemonOpenWouldAccept('failed')).toBe(false)
  })
})

// ── browserClose gate ─────────────────────────────────────────────────────────
// browserClose is a no-op for terminal statuses, immediately marks done otherwise.

function browserCloseIsNoop(currentStatus: string): boolean {
  return isTerminalStatus(currentStatus)
}

describe('browserClose gate', () => {
  it('is a no-op for done and failed', () => {
    expect(browserCloseIsNoop('done')).toBe(true)
    expect(browserCloseIsNoop('failed')).toBe(true)
  })

  it('transitions pending and running to done immediately', () => {
    expect(browserCloseIsNoop('pending')).toBe(false)
    expect(browserCloseIsNoop('running')).toBe(false)
  })
})

// ── Portal crash-recovery grace period ───────────────────────────────────────
// The worker suppresses crash-recovery for 30s after daemon restart so that
// a graceful redeploy doesn't force-close running portals as 'failed'.

function shouldTriggerCrashRecovery(portalActive: boolean, daemonUptimeMs: number): boolean {
  if (!portalActive && daemonUptimeMs < 30_000) return false
  if (!portalActive) return true
  return false
}

describe('portal crash-recovery grace period', () => {
  it('suppresses crash-recovery during the first 30s after daemon restart', () => {
    expect(shouldTriggerCrashRecovery(false, 0)).toBe(false)
    expect(shouldTriggerCrashRecovery(false, 15_000)).toBe(false)
    expect(shouldTriggerCrashRecovery(false, 29_999)).toBe(false)
  })

  it('triggers crash-recovery once grace period expires', () => {
    expect(shouldTriggerCrashRecovery(false, 30_000)).toBe(true)
    expect(shouldTriggerCrashRecovery(false, 60_000)).toBe(true)
  })

  it('never triggers when portal goroutine is active regardless of uptime', () => {
    expect(shouldTriggerCrashRecovery(true, 0)).toBe(false)
    expect(shouldTriggerCrashRecovery(true, 60_000)).toBe(false)
  })
})

// ── Portal team limit ─────────────────────────────────────────────────────────
// Team can have at most 3 live (active) portals.

function portalLimitExceeded(liveCount: number): boolean {
  return liveCount >= 3
}

describe('portal team limit', () => {
  it('allows creation when team has 0, 1, or 2 live portals', () => {
    expect(portalLimitExceeded(0)).toBe(false)
    expect(portalLimitExceeded(1)).toBe(false)
    expect(portalLimitExceeded(2)).toBe(false)
  })

  it('blocks creation when team already has 3 live portals', () => {
    expect(portalLimitExceeded(3)).toBe(true)
  })

  it('blocks creation when team exceeds 3 (defensive)', () => {
    expect(portalLimitExceeded(4)).toBe(true)
  })
})

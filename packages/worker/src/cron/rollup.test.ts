import { describe, it, expect, beforeEach } from 'vitest'
import { compileRollupContent, dailyPeriodKey, weeklyPeriodKey, periodBounds, runRollups } from './rollup.js'
import type { Env } from '../types.js'

// ── Period keys ──────────────────────────────────────────────────────────────

describe('dailyPeriodKey', () => {
  it('formats as YYYY-MM-DD in UTC', () => {
    expect(dailyPeriodKey(new Date('2026-07-11T23:59:00Z'))).toBe('2026-07-11')
  })

  it('does not roll over based on local time zone offsets', () => {
    expect(dailyPeriodKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01')
  })
})

describe('weeklyPeriodKey', () => {
  it('computes ISO week 01 for 2024-01-01 (a Monday)', () => {
    expect(weeklyPeriodKey(new Date('2024-01-01T12:00:00Z'))).toBe('2024-W01')
  })

  it('assigns the year-boundary date 2024-12-31 to the next year\'s week 01', () => {
    // Jan 1 2025 is a Wednesday, so ISO week 2025-W01 starts Monday Dec 30 2024.
    expect(weeklyPeriodKey(new Date('2024-12-31T12:00:00Z'))).toBe('2025-W01')
  })

  it('always returns the YYYY-Www shape', () => {
    expect(weeklyPeriodKey(new Date('2026-07-11T00:00:00Z'))).toMatch(/^\d{4}-W\d{2}$/)
  })
})

describe('periodBounds', () => {
  it('daily bounds span exactly 24h starting at UTC midnight', () => {
    const { start, end, periodKey } = periodBounds('daily', new Date('2026-07-11T15:30:00Z'))
    expect(start).toBe(Date.UTC(2026, 6, 11, 0, 0, 0))
    expect(end - start).toBe(24 * 60 * 60 * 1000)
    expect(periodKey).toBe('2026-07-11')
  })

  it('weekly bounds span exactly 7 days starting Monday UTC midnight', () => {
    // 2026-07-11 is a Saturday; the containing week starts Monday 2026-07-06.
    const { start, end, periodKey } = periodBounds('weekly', new Date('2026-07-11T15:30:00Z'))
    expect(start).toBe(Date.UTC(2026, 6, 6, 0, 0, 0))
    expect(end - start).toBe(7 * 24 * 60 * 60 * 1000)
    expect(periodKey).toMatch(/^\d{4}-W\d{2}$/)
  })
})

// ── compileRollupContent ───────────────────────────────────────────────────────
// Plain concatenate-and-format pass (v1, no LLM call — see the comment in rollup.ts).

describe('compileRollupContent', () => {
  it('returns a placeholder for an empty period', () => {
    expect(compileRollupContent([])).toBe('_No memory entries recorded in this period._')
  })

  it('groups entries under a heading per category, in fixed category order', () => {
    const content = compileRollupContent([
      { category: 'events', title: 'Deployed v2', content: 'Shipped the new release.' },
      { category: 'architecture', title: 'Switched to D1', content: 'Moved off Postgres.' },
    ])
    const architectureIdx = content.indexOf('## Architecture')
    const eventsIdx = content.indexOf('## Events')
    expect(architectureIdx).toBeGreaterThanOrEqual(0)
    expect(eventsIdx).toBeGreaterThanOrEqual(0)
    expect(architectureIdx).toBeLessThan(eventsIdx) // fixed order, not input order
    expect(content).toContain('- **Switched to D1** — Moved off Postgres.')
    expect(content).toContain('- **Deployed v2** — Shipped the new release.')
  })

  it('omits categories with no entries', () => {
    const content = compileRollupContent([{ category: 'personal', title: 'x', content: 'y' }])
    expect(content).not.toContain('## Events')
    expect(content).not.toContain('## Architecture')
    expect(content).toContain('## Personal')
  })

  it('collapses whitespace and truncates a long content excerpt', () => {
    const longContent = 'word '.repeat(60) // 300 chars, well over the 140-char excerpt limit
    const content = compileRollupContent([{ category: 'structure', title: 'Long entry', content: longContent }])
    const line = content.split('\n').find(l => l.includes('Long entry'))!
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(longContent.length)
  })

  it('groups multiple entries within the same category under one heading', () => {
    const content = compileRollupContent([
      { category: 'preferences', title: 'A', content: 'a' },
      { category: 'preferences', title: 'B', content: 'b' },
    ])
    expect(content.match(/## Preferences/g)).toHaveLength(1)
    expect(content).toContain('- **A** — a')
    expect(content).toContain('- **B** — b')
  })
})

// ── runRollups ─────────────────────────────────────────────────────────────────
// Minimal fake D1 scoped to teams/memory/memory_rollup — enough to verify the
// cron entry point's team filtering and idempotency without needing the actual
// Cron Trigger to fire.

interface TeamRow { id: string; memory_enabled: number; is_deactivated: number }
interface MemoryRow { team_id: string; category: string; title: string; content: string; created_at: number }
interface RollupRow { id: string; team_id: string; period: string; period_key: string; content: string; created_at: number }

function norm(sql: string) { return sql.replace(/\s+/g, ' ').trim() }

class FakeRollupDB {
  teams: TeamRow[] = []
  memory: MemoryRow[] = []
  rollups: RollupRow[] = []

  prepare(sql: string) {
    const s = norm(sql)
    const db = this
    let bound: unknown[] = []
    const api = {
      bind(...args: unknown[]) { bound = args; return api },
      async first<T>(): Promise<T | null> { return db.dispatchFirst(s, bound) as T | null },
      async all<T>() { return { results: db.dispatchAll(s, bound) as T[] } },
      async run() { return db.dispatchRun(s, bound) },
    }
    return api
  }

  private dispatchFirst(sql: string, args: unknown[]): unknown {
    if (sql.startsWith('SELECT 1 FROM memory_rollup')) {
      const [teamId, period, periodKey] = args as [string, string, string]
      const hit = this.rollups.find(r => r.team_id === teamId && r.period === period && r.period_key === periodKey)
      return hit ? { 1: 1 } : null
    }
    throw new Error(`FakeRollupDB: unhandled first() query: ${sql}`)
  }

  private dispatchAll(sql: string, args: unknown[]): unknown[] {
    if (sql.startsWith('SELECT id FROM teams')) {
      return this.teams.filter(t => t.memory_enabled === 1 && t.is_deactivated === 0).map(t => ({ id: t.id }))
    }
    if (sql.startsWith('SELECT category, title, content FROM memory')) {
      const [teamId, start, end] = args as [string, number, number]
      return this.memory.filter(m => m.team_id === teamId && m.created_at >= start && m.created_at < end)
    }
    throw new Error(`FakeRollupDB: unhandled all() query: ${sql}`)
  }

  private dispatchRun(sql: string, args: unknown[]): { meta: { changes: number } } {
    if (sql.startsWith('INSERT OR IGNORE INTO memory_rollup')) {
      const [id, teamId, period, periodKey, content, createdAt] = args as [string, string, string, string, string, number]
      if (this.rollups.some(r => r.team_id === teamId && r.period === period && r.period_key === periodKey)) {
        return { meta: { changes: 0 } }
      }
      this.rollups.push({ id, team_id: teamId, period, period_key: periodKey, content, created_at: createdAt })
      return { meta: { changes: 1 } }
    }
    throw new Error(`FakeRollupDB: unhandled run() query: ${sql}`)
  }
}

function makeEnv(db: FakeRollupDB): Env {
  return { DB: db as unknown as D1Database } as unknown as Env
}

let db: FakeRollupDB
beforeEach(() => {
  db = new FakeRollupDB()
})

describe('runRollups', () => {
  it('skips teams with memory_enabled=0', async () => {
    db.teams.push({ id: 'team-off', memory_enabled: 0, is_deactivated: 0 })
    await runRollups(makeEnv(db), new Date('2026-07-11T12:00:00Z'))
    expect(db.rollups).toHaveLength(0)
  })

  it('skips deactivated teams', async () => {
    db.teams.push({ id: 'team-gone', memory_enabled: 1, is_deactivated: 1 })
    await runRollups(makeEnv(db), new Date('2026-07-11T12:00:00Z'))
    expect(db.rollups).toHaveLength(0)
  })

  it('creates one daily and one weekly rollup per eligible team, scoped to that period\'s entries', async () => {
    db.teams.push({ id: 'team-1', memory_enabled: 1, is_deactivated: 0 })
    db.memory.push(
      { team_id: 'team-1', category: 'events', title: 'In period', content: 'x', created_at: Date.UTC(2026, 6, 11, 10, 0, 0) },
      { team_id: 'team-1', category: 'events', title: 'Out of period', content: 'y', created_at: Date.UTC(2026, 6, 9, 10, 0, 0) },
    )

    await runRollups(makeEnv(db), new Date('2026-07-11T12:00:00Z'))

    expect(db.rollups).toHaveLength(2) // daily + weekly
    const daily = db.rollups.find(r => r.period === 'daily')!
    expect(daily.period_key).toBe('2026-07-11')
    expect(daily.content).toContain('In period')
    expect(daily.content).not.toContain('Out of period')

    const weekly = db.rollups.find(r => r.period === 'weekly')!
    expect(weekly.content).toContain('In period')
    expect(weekly.content).toContain('Out of period') // both fall within the same ISO week
  })

  it('is idempotent — a second run for the same period does not duplicate rollups', async () => {
    db.teams.push({ id: 'team-1', memory_enabled: 1, is_deactivated: 0 })
    const now = new Date('2026-07-11T12:00:00Z')

    await runRollups(makeEnv(db), now)
    const countAfterFirst = db.rollups.length
    await runRollups(makeEnv(db), now)

    expect(db.rollups).toHaveLength(countAfterFirst)
  })
})

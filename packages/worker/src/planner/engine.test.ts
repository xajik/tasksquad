import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PlannerEngine } from './engine.js'

// Helper used both in makeDb and in fixture key construction
function normSql(sql: string) { return sql.trim().replace(/\s+/g, ' ') }
import type { IPhaseDispatcher } from './dispatcher.js'
import type { IVerificationStrategy } from './supervisor.js'
import type { PlannerRow, PhaseRow } from './types.js'

// ── Minimal D1 mock ───────────────────────────────────────────────────────────
//
// Supports the subset of D1 the engine uses:
//   db.prepare(sql).bind(...args).first<T>()  → looks up fixture by normalised
//                                               SQL + JSON-stringified binds,
//                                               then falls back to SQL-only key
//   db.prepare(sql).bind(...args).run()        → records normalised SQL, no-op
//   db.batch([stmt, ...])                      → runs all stmts
//
// Fixture keys:
//   sql-only:              'SELECT * FROM planners WHERE id = ?'
//   sql+binds (specific):  'SELECT * FROM planner_phases…:["planner-1",1]'

type QueryResult = Record<string, unknown> | null

function makeDb(fixtures: Map<string, QueryResult>) {
  const ran: string[] = []

  function stmt(sql: string, binds: unknown[]) {
    const sqlKey      = normSql(sql)
    const specificKey = `${sqlKey}:${JSON.stringify(binds)}`
    return {
      async first<T>() {
        const hit = fixtures.get(specificKey) ?? fixtures.get(sqlKey)
        return (hit ?? null) as T | null
      },
      async run() {
        // Record full normalised SQL so test assertions can search any part of it
        ran.push(sqlKey)
      },
    }
  }

  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      return {
        bind(...a: unknown[]) { args = a; return stmt(sql, a) },
        ...stmt(sql, args),
      }
    },
    async batch(stmts: ReturnType<typeof stmt>[]) {
      for (const s of stmts) await s.run()
    },
    _ran: ran,
  }

  return db as unknown as D1Database & { _ran: string[] }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLANNER: PlannerRow = {
  id: 'planner-1', team_id: 'team-1', sender_id: 'user-1',
  name: 'Test', description: null, status: 'running',
  current_phase_index: 0, max_retries: 3, auto_close: 0, paused: 0,
  default_sub_agent_id: null, default_harness_agent_id: 'agent-1',
  planner_verdict: null, created_at: 1000, updated_at: 1000,
}

const PHASE_0: PhaseRow = {
  id: 'phase-0', planner_id: 'planner-1', phase_index: 0,
  name: 'Research', sub_agent_id: null, harness_agent_id: 'agent-1',
  status: 'in_progress', task_id: 'task-0', retry_count: 0, max_retries: 3,
  auto_close: 0, user_verdict: null, last_response: null,
  supervisor_status: null, supervisor_verdict: null,
  created_at: 1000, updated_at: 1000,
}

const PHASE_1: PhaseRow = {
  ...PHASE_0, id: 'phase-1', phase_index: 1, name: 'Implement', status: 'pending', task_id: null,
}

// Mock dispatcher always returns a predictable task ID
const mockDispatcher: IPhaseDispatcher = {
  dispatch: vi.fn().mockResolvedValue('new-task-id'),
}

// Mock verifier that never triggers supervisor
const mockVerifier: IVerificationStrategy = {
  shouldVerify: vi.fn().mockReturnValue(false),
  dispatch: vi.fn(),
  parseResponse: vi.fn(),
}

// ── Tests: advance ─────────────────────────────────────────────────────────────

describe('PlannerEngine.advance', () => {
  let engine: PlannerEngine

  beforeEach(() => {
    vi.clearAllMocks()
    engine = new PlannerEngine(mockDispatcher, mockVerifier)
  })

  it('dispatches next phase and emits phase_dispatched', async () => {
    const fixtures = new Map([
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
      ['SELECT COUNT(*) as count FROM planner_phases WHERE planner_id = ?', { count: 2 }],
      ['SELECT * FROM planner_phases WHERE planner_id = ? AND phase_index = ?', PHASE_1],
    ])
    const db = makeDb(fixtures)

    const events = await engine.advance(db, 'planner-1')

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'phase_dispatched', taskId: 'new-task-id' })
    )
    expect(mockDispatcher.dispatch).toHaveBeenCalledOnce()
  })

  it('marks planner completed when no more phases remain', async () => {
    // current_phase_index is 0, advancing would go to index 1, but count is 1 → done
    const fixtures = new Map([
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
      ['SELECT COUNT(*) as count FROM planner_phases WHERE planner_id = ?', { count: 1 }],
    ])
    const db = makeDb(fixtures)

    const events = await engine.advance(db, 'planner-1')

    expect(events).toContainEqual({ type: 'planner_completed', plannerId: 'planner-1' })
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('emits planner_paused and skips dispatch when planner.paused = 1', async () => {
    const fixtures = new Map([
      ['SELECT * FROM planners WHERE id = ?', { ...PLANNER, paused: 1 }],
    ])
    const db = makeDb(fixtures)

    const events = await engine.advance(db, 'planner-1')

    expect(events).toContainEqual({ type: 'planner_paused', plannerId: 'planner-1' })
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('returns [] when planner.status is completed', async () => {
    const fixtures = new Map([
      ['SELECT * FROM planners WHERE id = ?', { ...PLANNER, status: 'completed', paused: 0 }],
    ])
    const db = makeDb(fixtures)
    const events = await engine.advance(db, 'planner-1')
    expect(events).toHaveLength(0)
  })

  it('returns [] when planner.status is failed', async () => {
    const fixtures = new Map([
      ['SELECT * FROM planners WHERE id = ?', { ...PLANNER, status: 'failed', paused: 0 }],
    ])
    const db = makeDb(fixtures)
    const events = await engine.advance(db, 'planner-1')
    expect(events).toHaveLength(0)
  })
})

// ── Tests: retry ───────────────────────────────────────────────────────────────

describe('PlannerEngine.retry', () => {
  let engine: PlannerEngine

  beforeEach(() => {
    vi.clearAllMocks()
    engine = new PlannerEngine(mockDispatcher, mockVerifier)
  })

  it('increments retry_count and re-dispatches', async () => {
    const fixtures = new Map([
      ['SELECT * FROM planner_phases WHERE id = ?', PHASE_0],
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
    ])
    const db = makeDb(fixtures)

    const events = await engine.retry(db, 'phase-0')

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'phase_retried', retryCount: 1 })
    )
    expect(mockDispatcher.dispatch).toHaveBeenCalledOnce()
  })

  it('marks phase + planner FAILED when retry_count >= max_retries', async () => {
    const exhausted: PhaseRow = { ...PHASE_0, retry_count: 3, max_retries: 3 }
    const fixtures = new Map([
      ['SELECT * FROM planner_phases WHERE id = ?', exhausted],
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
    ])
    const db = makeDb(fixtures)

    const events = await engine.retry(db, 'phase-0')

    expect(events).toContainEqual(expect.objectContaining({ type: 'phase_failed' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'planner_failed' }))
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('resets supervisor fields on retry (recorded in SQL)', async () => {
    const fixtures = new Map([
      ['SELECT * FROM planner_phases WHERE id = ?', PHASE_0],
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
    ])
    const db = makeDb(fixtures)

    await engine.retry(db, 'phase-0')

    // The reset UPDATE clears supervisor fields
    const resetSql = db._ran.find(s => s.includes('supervisor_status'))
    expect(resetSql).toBeTruthy()
  })
})

// ── Tests: onVerdict — inbox_grade ─────────────────────────────────────────────

describe('PlannerEngine.onVerdict — inbox_grade', () => {
  let engine: PlannerEngine

  beforeEach(() => {
    vi.clearAllMocks()
    engine = new PlannerEngine(mockDispatcher, mockVerifier)
  })

  it('grade=1 → phase completed, advance called, phase_dispatched emitted', async () => {
    const fixtures = new Map([
      ['SELECT phase_id, role FROM planner_task WHERE task_id = ?', { phase_id: 'phase-0', role: 'phase' }],
      ['SELECT * FROM planner_phases WHERE id = ?', PHASE_0],
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
      ['SELECT body FROM messages', { body: 'Great work.' }],
      ['SELECT COUNT(*) as count FROM planner_phases WHERE planner_id = ?', { count: 2 }],
      ['SELECT * FROM planner_phases WHERE planner_id = ? AND phase_index = ?', PHASE_1],
    ])
    const db = makeDb(fixtures)

    const events = await engine.onVerdict(db, 'task-0', { kind: 'inbox_grade', grade: 1 })

    expect(events).toContainEqual(expect.objectContaining({ type: 'phase_completed' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'phase_dispatched' }))
    expect(mockDispatcher.dispatch).toHaveBeenCalledOnce()
  })

  it('grade=0 → retry called, phase_retried emitted', async () => {
    const fixtures = new Map([
      ['SELECT phase_id, role FROM planner_task WHERE task_id = ?', { phase_id: 'phase-0', role: 'phase' }],
      ['SELECT * FROM planner_phases WHERE id = ?', PHASE_0],
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
    ])
    const db = makeDb(fixtures)

    const events = await engine.onVerdict(db, 'task-0', { kind: 'inbox_grade', grade: 0 })

    expect(events).toContainEqual(expect.objectContaining({ type: 'phase_retried' }))
    expect(mockDispatcher.dispatch).toHaveBeenCalledOnce() // re-dispatch on retry
  })

  it('grade=1 on last phase → planner_completed emitted', async () => {
    const fixtures = new Map([
      ['SELECT phase_id, role FROM planner_task WHERE task_id = ?', { phase_id: 'phase-0', role: 'phase' }],
      ['SELECT * FROM planner_phases WHERE id = ?', PHASE_0],
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
      ['SELECT body FROM messages', { body: 'Done.' }],
      ['SELECT COUNT(*) as count FROM planner_phases WHERE planner_id = ?', { count: 1 }],
    ])
    const db = makeDb(fixtures)

    const events = await engine.onVerdict(db, 'task-0', { kind: 'inbox_grade', grade: 1 })

    expect(events).toContainEqual(expect.objectContaining({ type: 'planner_completed' }))
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('returns [] when task has no planner_task entry', async () => {
    const fixtures = new Map([
      ['SELECT phase_id, role FROM planner_task WHERE task_id = ?', null],
    ])
    const db = makeDb(fixtures)
    const events = await engine.onVerdict(db, 'orphan-task', { kind: 'inbox_grade', grade: 1 })
    expect(events).toHaveLength(0)
  })
})

// ── Tests: onVerdict — auto_close ──────────────────────────────────────────────

describe('PlannerEngine.onVerdict — auto_close', () => {
  it('auto_close treated as passing grade → phase_completed emitted', async () => {
    const engine = new PlannerEngine(mockDispatcher, mockVerifier)
    const fixtures = new Map([
      ['SELECT phase_id, role FROM planner_task WHERE task_id = ?', { phase_id: 'phase-0', role: 'phase' }],
      ['SELECT * FROM planner_phases WHERE id = ?', PHASE_0],
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
      ['SELECT body FROM messages', { body: 'Auto closed.' }],
      ['SELECT COUNT(*) as count FROM planner_phases WHERE planner_id = ?', { count: 2 }],
      ['SELECT * FROM planner_phases WHERE planner_id = ? AND phase_index = ?', PHASE_1],
    ])
    const db = makeDb(fixtures)

    const events = await engine.onVerdict(db, 'task-0', { kind: 'auto_close' })

    expect(events).toContainEqual(expect.objectContaining({ type: 'phase_completed' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'phase_dispatched' }))
  })
})

// ── Tests: onVerdict — supervisor ─────────────────────────────────────────────

describe('PlannerEngine.onVerdict — supervisor', () => {
  let engine: PlannerEngine

  beforeEach(() => {
    vi.clearAllMocks()
    engine = new PlannerEngine(mockDispatcher, mockVerifier)
  })

  it('verdict=yes → advance called, next phase dispatched', async () => {
    const supPhase: PhaseRow = { ...PHASE_0, supervisor_verdict: null }
    const fixtures = new Map([
      ['SELECT phase_id, role FROM planner_task WHERE task_id = ?', { phase_id: 'phase-0', role: 'supervisor' }],
      ['SELECT * FROM planner_phases WHERE id = ?', supPhase],
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
      ['SELECT COUNT(*) as count FROM planner_phases WHERE planner_id = ?', { count: 2 }],
      ['SELECT * FROM planner_phases WHERE planner_id = ? AND phase_index = ?', PHASE_1],
    ])
    const db = makeDb(fixtures)

    const events = await engine.onVerdict(db, 'sup-task', { kind: 'supervisor', verdict: 'yes' })

    expect(events).toContainEqual(expect.objectContaining({ type: 'phase_dispatched' }))
  })

  it('verdict=no → retry called', async () => {
    const supPhase: PhaseRow = { ...PHASE_0, supervisor_verdict: null }
    const fixtures = new Map([
      ['SELECT phase_id, role FROM planner_task WHERE task_id = ?', { phase_id: 'phase-0', role: 'supervisor' }],
      ['SELECT * FROM planner_phases WHERE id = ?', supPhase],
      ['SELECT * FROM planners WHERE id = ?', PLANNER],
    ])
    const db = makeDb(fixtures)

    const events = await engine.onVerdict(db, 'sup-task', { kind: 'supervisor', verdict: 'no' })

    expect(events).toContainEqual(expect.objectContaining({ type: 'phase_retried' }))
  })
})

// ── Tests: resume ──────────────────────────────────────────────────────────────

describe('PlannerEngine.resume', () => {
  let engine: PlannerEngine

  beforeEach(() => {
    vi.clearAllMocks()
    engine = new PlannerEngine(mockDispatcher, mockVerifier)
  })

  it('clears paused flag and returns [] when current phase is still in_progress', async () => {
    const pausedPlanner = { ...PLANNER, paused: 0 }
    const fixtures = new Map([
      ['SELECT * FROM planners WHERE id = ?', pausedPlanner],
      ['SELECT * FROM planner_phases WHERE planner_id = ? AND phase_index = ?',
        { ...PHASE_0, status: 'in_progress', user_verdict: null }],
    ])
    const db = makeDb(fixtures)

    const events = await engine.resume(db, 'planner-1')

    expect(events).toHaveLength(0)
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('immediately advances when current phase is completed + approved + no supervisor', async () => {
    const pausedPlanner = { ...PLANNER, paused: 0 }
    const completedPhase: PhaseRow = {
      ...PHASE_0, status: 'completed', user_verdict: 'approved', supervisor_status: null,
    }
    const phaseQuery = normSql('SELECT * FROM planner_phases WHERE planner_id = ? AND phase_index = ?')
    const fixtures = new Map([
      [normSql('SELECT * FROM planners WHERE id = ?'), pausedPlanner],
      // resume() reads current_phase_index=0
      [`${phaseQuery}:${JSON.stringify(['planner-1', 0])}`, completedPhase],
      // advance() reads next index=1
      [`${phaseQuery}:${JSON.stringify(['planner-1', 1])}`, PHASE_1],
      [normSql('SELECT COUNT(*) as count FROM planner_phases WHERE planner_id = ?'), { count: 2 }],
    ])
    const db = makeDb(fixtures)

    const events = await engine.resume(db, 'planner-1')

    expect(events).toContainEqual(expect.objectContaining({ type: 'phase_dispatched' }))
  })
})

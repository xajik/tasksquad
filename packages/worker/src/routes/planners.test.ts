import { describe, it, expect } from 'vitest'

// ── validateCreate — inlined from planners.ts ─────────────────────────────────
// Private function tested by copying the implementation, matching the conveyors pattern.

interface CreatePhaseInput {
  name: string
  sub_agent_id?: string
  harness_agent_id?: string
  max_retries?: number
  auto_close?: boolean
}

interface CreatePlannerBody {
  name: string
  description?: string
  max_retries?: number
  auto_close?: boolean
  default_sub_agent_id?: string
  default_harness_agent_id?: string
  phases: CreatePhaseInput[]
}

function validateCreate(body: unknown): string | null {
  const b = body as Partial<CreatePlannerBody>
  if (!b.name?.trim()) return 'name_required'
  if (!Array.isArray(b.phases) || b.phases.length === 0) return 'phases_required'
  if (b.max_retries !== undefined && (b.max_retries < 1 || b.max_retries > 20)) return 'invalid_max_retries'
  for (const p of b.phases) {
    if (!p.name?.trim()) return 'phase_name_required'
  }
  return null
}

describe('validateCreate', () => {
  it('returns null for a minimal valid planner', () => {
    expect(validateCreate({ name: 'My Planner', phases: [{ name: 'Phase 1' }] })).toBeNull()
  })

  it('returns null with optional fields present', () => {
    expect(validateCreate({
      name: 'Planner',
      description: 'Some desc',
      max_retries: 5,
      auto_close: true,
      default_sub_agent_id: 'sub-1',
      default_harness_agent_id: 'agent-1',
      phases: [{ name: 'P1' }, { name: 'P2', max_retries: 2 }],
    })).toBeNull()
  })

  it('returns name_required when name is missing', () => {
    expect(validateCreate({ phases: [{ name: 'P1' }] })).toBe('name_required')
  })

  it('returns name_required when name is whitespace only', () => {
    expect(validateCreate({ name: '   ', phases: [{ name: 'P1' }] })).toBe('name_required')
  })

  it('returns phases_required when phases array is missing', () => {
    expect(validateCreate({ name: 'Planner' })).toBe('phases_required')
  })

  it('returns phases_required when phases array is empty', () => {
    expect(validateCreate({ name: 'Planner', phases: [] })).toBe('phases_required')
  })

  it('returns invalid_max_retries when max_retries < 1', () => {
    expect(validateCreate({ name: 'P', phases: [{ name: 'Ph' }], max_retries: 0 })).toBe('invalid_max_retries')
  })

  it('returns invalid_max_retries when max_retries > 20', () => {
    expect(validateCreate({ name: 'P', phases: [{ name: 'Ph' }], max_retries: 21 })).toBe('invalid_max_retries')
  })

  it('accepts max_retries at boundary values 1 and 20', () => {
    expect(validateCreate({ name: 'P', phases: [{ name: 'Ph' }], max_retries: 1 })).toBeNull()
    expect(validateCreate({ name: 'P', phases: [{ name: 'Ph' }], max_retries: 20 })).toBeNull()
  })

  it('returns phase_name_required when a phase has no name', () => {
    expect(validateCreate({ name: 'P', phases: [{ name: '' }] })).toBe('phase_name_required')
  })

  it('returns phase_name_required for the second phase missing name', () => {
    expect(validateCreate({ name: 'P', phases: [{ name: 'Ph1' }, { name: '' }] })).toBe('phase_name_required')
  })

  it('accepts phases without optional fields (sub_agent_id nullable)', () => {
    expect(validateCreate({ name: 'P', phases: [{ name: 'Ph', sub_agent_id: undefined }] })).toBeNull()
  })
})

// ── Phase inheritance logic ────────────────────────────────────────────────────
// Mirrors the behaviour in planners.ts:create where phase fields fall back to planner defaults.

function resolvePhaseAgents(
  phase: { sub_agent_id?: string; harness_agent_id?: string },
  defaults: { default_sub_agent_id?: string; default_harness_agent_id?: string },
) {
  return {
    sub_agent_id:     phase.sub_agent_id     ?? defaults.default_sub_agent_id     ?? null,
    harness_agent_id: phase.harness_agent_id ?? defaults.default_harness_agent_id ?? null,
  }
}

describe('phase agent resolution', () => {
  it('uses phase-level values when provided', () => {
    const result = resolvePhaseAgents(
      { sub_agent_id: 'ph-sub', harness_agent_id: 'ph-harness' },
      { default_sub_agent_id: 'plan-sub', default_harness_agent_id: 'plan-harness' },
    )
    expect(result.sub_agent_id).toBe('ph-sub')
    expect(result.harness_agent_id).toBe('ph-harness')
  })

  it('falls back to planner defaults when phase fields are absent', () => {
    const result = resolvePhaseAgents(
      {},
      { default_sub_agent_id: 'plan-sub', default_harness_agent_id: 'plan-harness' },
    )
    expect(result.sub_agent_id).toBe('plan-sub')
    expect(result.harness_agent_id).toBe('plan-harness')
  })

  it('returns null when neither phase nor planner have agents', () => {
    const result = resolvePhaseAgents({}, {})
    expect(result.sub_agent_id).toBeNull()
    expect(result.harness_agent_id).toBeNull()
  })
})

// ── auto_close cascade ────────────────────────────────────────────────────────

function resolvePhaseAutoClose(phaseAutoClose: boolean | undefined, plannerAutoClose: boolean): number {
  const effective = plannerAutoClose ? true : (phaseAutoClose ?? false)
  return effective ? 1 : 0
}

describe('auto_close cascade', () => {
  it('planner auto_close=true forces all phases to 1', () => {
    expect(resolvePhaseAutoClose(false, true)).toBe(1)
    expect(resolvePhaseAutoClose(undefined, true)).toBe(1)
  })

  it('planner auto_close=false respects phase-level setting', () => {
    expect(resolvePhaseAutoClose(true, false)).toBe(1)
    expect(resolvePhaseAutoClose(false, false)).toBe(0)
    expect(resolvePhaseAutoClose(undefined, false)).toBe(0)
  })
})

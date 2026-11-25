import { describe, expect, it } from 'vitest'
import { graphPhase } from './graphPhase'

describe('graphPhase', () => {
  it('separates planning, execution, grading and recovery roles', () => {
    expect(['decompose', 'plan', 'merge'].map(graphPhase)).toEqual(['PLAN', 'PLAN', 'PLAN'])
    expect(['execute', 'undo'].map(graphPhase)).toEqual(['EXECUTION', 'EXECUTION'])
    expect(['grade', 'project'].map(graphPhase)).toEqual(['GRADING', 'GRADING'])
    expect(['continue', 'reconcile', 'repair'].map(graphPhase)).toEqual(['RECOVERY', 'RECOVERY', 'RECOVERY'])
  })
})

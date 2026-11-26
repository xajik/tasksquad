/** Which stage of the graph a role belongs to. Planning proposes and reviews actions; execution runs them. */
export type GraphPhase = 'PLAN' | 'EXECUTION' | 'GRADING' | 'RECOVERY'

const PHASES: Record<string, GraphPhase> = {
  decompose: 'PLAN',
  plan: 'PLAN',
  merge: 'PLAN',
  execute: 'EXECUTION',
  undo: 'EXECUTION',
  grade: 'GRADING',
  project: 'GRADING',
  continue: 'RECOVERY',
  reconcile: 'RECOVERY',
  repair: 'RECOVERY'
}

export function graphPhase(role: string): GraphPhase {
  return PHASES[role] ?? 'RECOVERY'
}

/** Badge colours: planning is blue, execution green, grading violet, recovery amber. */
export const PHASE_CLASS: Record<GraphPhase, string> = {
  PLAN: 'text-status-info',
  EXECUTION: 'text-status-success',
  GRADING: 'text-status-violet',
  RECOVERY: 'text-status-warning'
}

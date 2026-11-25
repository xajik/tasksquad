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
  PLAN: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  EXECUTION: 'bg-green-500/15 text-green-700 dark:text-green-300',
  GRADING: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  RECOVERY: 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
}

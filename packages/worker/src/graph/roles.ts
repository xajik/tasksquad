import type { Role } from './contracts.js'

/** The one place that classifies graph roles; engine, eligibility and maintenance share it. */
export const RECOVERY_ROLES: readonly Role[] = ['undo', 'reconcile']
export const REVIEW_ROLES: readonly Role[] = ['grade', 'project']
export const PLANNING_ROLES: readonly Role[] = ['decompose', 'plan', 'merge']
export const CONTROL_ROLES: readonly Role[] = [...RECOVERY_ROLES, ...REVIEW_ROLES, 'continue', 'repair']
/** Roles whose sessions stay open for end-of-session steps. */
export const EXECUTION_ROLES: readonly Role[] = ['execute', 'continue', 'undo']

export const isReview = (role: string) => (REVIEW_ROLES as readonly string[]).includes(role)
export const isPlanning = (role: string) => (PLANNING_ROLES as readonly string[]).includes(role)

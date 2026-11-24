import { type Role } from '../contracts.js'
import { rows, sql, type Assignment, type Data, type Graph } from '../store.js'
import { actionable, continuationRoot } from './shared.js'

/** A restoration predicate is verified by unexpired evidence that reports it exactly as 'true'. */
export const predicateVerified = (evidence: Data[], predicate: string) =>
  evidence.some((e) => e.predicate === predicate && e.value === 'true' && Number(e.expires_at) > Date.now())

/** A 'restored' reconcile must verify every restoration predicate by exact text; checked at parse so repair can fix it. */
export async function assertReconcileRestoration(db: D1Database, original: Assignment, d: Data): Promise<void> {
  if (original.role !== 'reconcile' || d.decision !== 'terminated_restored') return
  const prior = await sql(
    db,
    'SELECT * FROM graph_assignments WHERE id=?',
    original.parent_id
  ).first<Assignment>()
  const predicates = (((JSON.parse(prior?.input ?? '{}') as Data).plan as Data | undefined)
    ?.restoration_predicates ?? []) as string[]
  const evidence = (d.evidence as Data[]) ?? []
  const missing = predicates.filter((p) => !predicateVerified(evidence, p))
  if (!predicates.length || missing.length)
    throw new Error(
      `Restoration predicates are not verified; report evidence with these exact predicate strings: ${JSON.stringify(predicates)}`
    )
}

/** Evidence must cite a resource version supplied with the plan; checked when parsing so a repair can fix it. */
export function assertEvidenceResources(original: Assignment, d: Data): void {
  if (!['execute', 'undo', 'reconcile'].includes(original.role)) return
  const plan = (JSON.parse(original.input) as Data).plan as Data | undefined
  const permitted = (plan?.resource_versions ?? []) as string[]
  if (((d.evidence as Data[]) ?? []).some((e) => !permitted.includes(String(e.resource_id))))
    throw new Error(
      `Evidence references an unsupplied resource version; use only these resource IDs: ${JSON.stringify(permitted)}`
    )
}

/** A resume/restart of a side-effecting step must attest termination, baseline and checkpoint. Checked at parse
 * time so the agent is asked to repair its answer, instead of the owner hitting a dead end when accepting. */
export async function assertContinuationVerified(db: D1Database, original: Assignment, d: Data): Promise<void> {
  if (original.role !== 'continue' || d.decision === 'blocked') return
  const first = await sql(db, 'SELECT * FROM graph_assignments WHERE id=?', original.parent_id).first<Assignment>()
  const parent = first && (await continuationRoot(db, first)).root
  if (!parent || !actionable(parent.role as Role)) return
  if (
    d.termination_verified !== true ||
    d.baseline_unchanged !== true ||
    (d.decision === 'resume' && d.checkpoint_verified !== true)
  )
    throw new Error(
      'Continuation needs verified termination, baseline and checkpoint: set termination_verified and baseline_unchanged to true (and checkpoint_verified to true for resume) only if verified; otherwise answer decision "blocked" with the reason'
    )
}

/** The root goal and every active decomposed milestone, each with the exact success predicates it owns. A milestone
 * owns the rule predicates its text names; the root goal owns them all. Grading scores impact per goal by predicate. */
/** Milestone text is reworded and recased freely; compare predicates ignoring case, spacing and trailing stops. */
export const normalizePredicate = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()

export interface GoalScope {
  id: string
  kind: string
  title: string
  body: string
  predicates: string[]
}

export async function goalHierarchy(db: D1Database, g: Graph, rulePredicates: string[]): Promise<GoalScope[]> {
  const nodes = await rows<{ id: string; kind: string; title: string; body: string }>(
    db,
    `SELECT n.id,n.kind,n.title,n.body FROM graph_nodes n
     JOIN graph_node_states s ON s.id=(SELECT MAX(id) FROM graph_node_states WHERE node_id=n.id)
     WHERE n.graph_id=? AND n.kind IN ('goal','milestone') AND s.state='active'
     ORDER BY n.kind='goal' DESC, n.created_at`,
    g.id
  )
  return nodes.map((n) => ({
    ...n,
    predicates:
      n.kind === 'goal'
        ? rulePredicates
        : rulePredicates.filter((p) => normalizePredicate(n.body).includes(normalizePredicate(p)))
  }))
}

/** Per-goal impact must name supplied goals, that goal's own predicates and supplied evidence; checked at parse so a
 * repair can fix it. Only enforced when the grading context carried the goal hierarchy. */
export function assertGoalImpacts(original: Assignment, d: Data): void {
  if (original.role !== 'project') return
  const input = JSON.parse(original.input) as Data
  const goals = input.goals as GoalScope[] | undefined
  if (!goals?.length) return
  const impacts = (d.goal_impacts ?? []) as Data[]
  const evidence = ((input.evidence as Data[]) ?? []).map((e) => e.id)
  for (const i of impacts) {
    const goal = goals.find((x) => x.id === i.goal_id)
    if (!goal) throw new Error(`goal_impacts references an unsupplied goal; use only these goal IDs: ${JSON.stringify(goals.map((x) => x.id))}`)
    const predicates = (i.predicates ?? []) as string[]
    const bad = predicates.filter((p) => !goal.predicates.includes(p))
    if (bad.length) throw new Error(`goal_impacts predicates must be exact predicates of goal ${goal.id}: ${JSON.stringify(goal.predicates)}`)
    if (Number(i.actual) > 0 && (!predicates.length || !((i.evidence_ids as string[]) ?? []).length))
      throw new Error('goal_impacts actual above 0 needs the predicates advanced and supporting evidence IDs')
    if (((i.evidence_ids as string[]) ?? []).some((e) => !evidence.includes(e)))
      throw new Error('goal_impacts references unsupplied evidence')
  }
  if (new Set(impacts.map((i) => i.goal_id)).size !== impacts.length) throw new Error('goal_impacts repeats a goal')
  if (impacts.length && !impacts.some((i) => i.goal_id === d.primary_goal_id))
    throw new Error('primary_goal_id must name a goal listed in goal_impacts')
}

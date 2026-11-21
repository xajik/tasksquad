/** Plain-language digest of a role's structured result, so reviewers need not read raw JSON. */
export interface ResultSummary {
  headline: string
  rows: { label: string; value: string }[]
  consequence: string
}
type Json = Record<string, unknown>
const text = (v: unknown, max = 220) => {
  const s = typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Json[]) : [])
const num = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : 'unknown')

/** Assignment context a reviewer's summary can use: goal titles and the plan's projected impact per goal. */
export interface SummaryContext {
  goals?: { id: string; title: string }[]
  plan?: { projected_impact?: { goal_id: string; delta: number }[] }
}

export function summarizeResult(
  role: string,
  raw: string | null | undefined,
  operation?: string,
  context?: SummaryContext
): ResultSummary | null {
  let d: Json
  try {
    d = JSON.parse(raw ?? '')
  } catch {
    return null
  }
  if (!d || typeof d !== 'object') return null
  const rows: ResultSummary['rows'] = []
  switch (role) {
    case 'decompose': {
      const goals = list(d.subgoals)
      goals.forEach((g, i) =>
        rows.push({ label: `Subgoal ${i + 1} · necessity ${num(g.necessity_confidence)}`, value: text(g.title) })
      )
      if (Array.isArray(d.retire_ids) && d.retire_ids.length)
        rows.push({ label: 'Retire milestones', value: String(d.retire_ids.length) })
      return {
        headline: `The agent proposes ${goals.length} subgoal${goals.length === 1 ? '' : 's'} towards the goal.`,
        rows,
        consequence: 'Accepting sends each subgoal to independent merge review; nothing runs yet.'
      }
    }
    case 'plan': {
      const actions = list(d.actions)
      actions.forEach((a, i) => {
        rows.push({ label: `Action ${i + 1}`, value: text(a.title) })
        rows.push({
          label: '  steps · undo steps · cost',
          value: `${list(a.steps).length || (a.steps as unknown[] | undefined)?.length || 0} · ${(a.undo_steps as unknown[] | undefined)?.length ?? 0} · ${text(a.cost)} (recovery ${text(a.recovery_cost)})`
        })
        rows.push({ label: '  restoration checks', value: text((a.restoration_predicates as unknown[] | undefined)?.length ?? 0) })
      })
      return {
        headline: `The agent proposes ${actions.length} reversible action${actions.length === 1 ? '' : 's'}.`,
        rows,
        consequence: 'Accepting sends the plan to independent merge review; the action runs only after that.'
      }
    }
    case 'merge':
      rows.push({ label: 'Decision', value: text(d.decision) })
      if (d.equivalent_node_id) rows.push({ label: 'Same as', value: text(d.equivalent_node_id) })
      rows.push({ label: 'Reason', value: text(d.reason, 320) })
      return {
        headline:
          d.decision === 'distinct'
            ? 'Reviewer says this candidate is new and distinct.'
            : d.decision === 'equivalent'
              ? 'Reviewer says this candidate duplicates an existing item.'
              : `Reviewer is ${text(d.decision)} about this candidate.`,
        rows,
        consequence:
          d.decision === 'distinct'
            ? 'Accepting publishes it to the graph (an action will start executing).'
            : 'Accepting records the reviewer decision; uncertain or rejected candidates stay unpublished.'
      }
    case 'execute':
    case 'undo': {
      rows.push({ label: 'Outcome', value: text(d.outcome ?? (d.restored === true ? 'restored' : d.restored === false ? 'not restored' : '')) })
      rows.push({ label: 'Result', value: text(d.title) })
      rows.push({ label: 'What happened', value: text(d.description, 320) })
      for (const e of list(d.evidence))
        rows.push({ label: `Evidence · ${text(e.predicate, 60)}`, value: `${text(e.value)} (source ${text(e.resource_id, 60) || 'none'})` })
      return {
        headline: role === 'undo' ? 'The agent reports a restoration attempt.' : 'The agent reports it ran the action.',
        rows,
        consequence:
          'Accepting queues serial grading and goal projection. Rejecting blocks this action; side effects are not rolled back automatically.'
      }
    }
    case 'grade':
      rows.push({ label: 'Local quality', value: num(d.local_score) })
      rows.push({ label: 'Reason', value: text(d.reason, 320) })
      return { headline: `Local grade ${num(d.local_score)} for the executed action.`, rows, consequence: 'Accepting records the score and backs it up along the executed path.' }
    case 'project':
      if (operation === 'decomposition_review') {
        rows.push({ label: 'Decomposition alignment', value: num(d.goal_score) })
        rows.push({ label: 'Reason', value: text(d.reason, 420) })
        if (Array.isArray(d.decomposition_feedback))
          d.decomposition_feedback.forEach((f, i) => rows.push({ label: `Feedback ${i + 1}`, value: text(f, 320) }))
        return { headline: `Decomposition alignment ${num(d.goal_score)} — plan quality only.`, rows,
          consequence: 'This reviews the plan structure. It does not measure sales or verified goal achievement.' }
      }
      rows.push({ label: 'Goal alignment', value: num(d.goal_score) })
      list(d.goal_impacts).forEach((i) => {
        const title = context?.goals?.find((g) => g.id === i.goal_id)?.title ?? text(i.goal_id, 40)
        const projected = context?.plan?.projected_impact?.find((p) => p.goal_id === i.goal_id)?.delta
        const predicates = Array.isArray(i.predicates) ? i.predicates.length : 0
        rows.push({
          label: `${i.goal_id === d.primary_goal_id ? 'Most moved · ' : ''}${text(title, 60)}`,
          value: `actual ${num(i.actual)}${projected === undefined ? '' : ` vs projected ${num(projected)}`} · ${predicates} predicate${predicates === 1 ? '' : 's'}`
        })
      })
      rows.push({ label: 'Reason', value: text(d.reason, 420) })
      if (Array.isArray(d.decomposition_feedback))
        d.decomposition_feedback.forEach((f, i) => rows.push({ label: `Feedback ${i + 1}`, value: text(f, 320) }))
      return { headline: `Goal alignment ${num(d.goal_score)} (a belief, not proof).`, rows, consequence: 'Accepting records the projection; the goal stays unverified until evidence satisfies the success rule.' }
    case 'continue':
      rows.push({ label: 'Decision', value: text(d.decision) })
      rows.push({ label: 'Reason', value: text(d.reason, 320) })
      return { headline: `Continuation decision: ${text(d.decision)}.`, rows, consequence: 'Accepting applies the decision (resume, restart or stay blocked).' }
    case 'reconcile':
      rows.push({ label: 'Decision', value: text(d.decision) })
      rows.push({ label: 'Reason', value: text(d.reason, 320) })
      return { headline: `Reconciliation: ${text(d.decision)}.`, rows, consequence: 'Accepting lets recovery proceed only if side effects are accounted for.' }
    default:
      return null
  }
}

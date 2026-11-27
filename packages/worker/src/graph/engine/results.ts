import type { SemanticIndex } from '../dedup.js'
import { parseResult, templates } from '../contracts.js'
import { assignment, commit, configuration, json, rows, sql, type Assignment, type Attempt, type Data, type Graph, type Result } from '../store.js'
import { resolveEvidenceIds } from './accept/review.js'
import { rebindExecutionReview } from './accept/execute.js'
import { accept } from './accept.js'
import { assertContinuationVerified, assertEvidenceResources, assertGoalImpacts, assertPublishableEvidence, assertReconcileRestoration } from './assertions.js'

export async function resolve(
  db: D1Database,
  r: Result
): Promise<{ a: Assignment; original: Assignment; t: Attempt }> {
  const t = (await sql(db, 'SELECT * FROM graph_attempts WHERE id=?', r.attempt_id).first<Attempt>())!
  const a = (await sql(
    db,
    'SELECT * FROM graph_assignments WHERE id=?',
    t.assignment_id
  ).first<Assignment>())!
  const original =
    a.role === 'repair'
      ? (await sql(db, 'SELECT * FROM graph_assignments WHERE id=?', a.parent_id).first<Assignment>())!
      : a
  return { a, original, t }
}

/** Mark a result invalid and ask the agent to repair it (unless this already is a repair). */
export async function invalidateResult(
  db: D1Database,
  g: Graph,
  r: Result,
  a: Assignment,
  t: { id: string },
  e: unknown
): Promise<void> {
  const ops = [
    sql(db, "UPDATE graph_results SET status='invalid',validation_error=? WHERE id=?", String(e), r.id),
    sql(db, 'DELETE FROM graph_reservations WHERE attempt_id=?', t.id),
    sql(db, "UPDATE graph_assignments SET status='error' WHERE id=?", a.id)
  ]
  if (a.role !== 'repair') {
    const fix = await assignment(
      db,
      g,
      'repair',
      { raw: r.raw, original_role: a.role, original_assignment: a.id, validation_error: String(e) },
      { parent: a.id, node: a.node_id, edge: a.edge_id, originalRole: a.role as keyof typeof templates }
    )
    ops.push(...fix.statements)
  }
  await commit(db, g, 'parse_error', r.id, { error: String(e) }, ops)
}

/** A continuation waiting for review that can never be accepted (it predates parse-time validation) would hold
 * every later review behind it forever; send it back to the agent for repair. */
export async function revalidateReviews(db: D1Database, g: Graph): Promise<void> {
  const waiting = await rows<Result>(
    db,
    `SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? AND a.role='continue' AND r.status='review' AND r.parsed IS NOT NULL`,
    g.id
  )
  for (const r of waiting) {
    const { a, original, t } = await resolve(db, r)
    try {
      await assertContinuationVerified(db, original, JSON.parse(r.parsed as string) as Data)
    } catch (e) {
      await invalidateResult(db, g, r, a, t, e)
    }
  }
}

export async function processResults(db: D1Database, g: Graph, semantic?: SemanticIndex): Promise<void> {
  const pending = await rows<Result>(
    db,
    `SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? AND r.status='received' AND r.parsed IS NULL ORDER BY r.created_at,r.id`,
    g.id
  )
  for (const r of pending) {
    const { a, original, t } = await resolve(db, r),
      c = await configuration(db, g)
    if (a.config_version !== c.version) {
      // A stale result is discarded, but its agent must be released and the work must not stay 'running'.
      // Blocked (not pending) so a possibly side-effecting action is never silently repeated.
      await commit(db, g, 'stale', r.id, {}, [
        sql(db, "UPDATE graph_results SET status='stale' WHERE id=?", r.id),
        sql(db, 'DELETE FROM graph_reservations WHERE attempt_id=?', t.id),
        sql(db, "UPDATE graph_assignments SET status='blocked' WHERE id=? AND status='running'", a.id)
      ])
      continue
    }
    const awaitingGrade = c.policy.review === 'quality_50' && original.role === 'execute'
    try {
      const parsed = parseResult(original.role as keyof typeof templates, r.raw, c.policy.review)
      assertEvidenceResources(original, parsed as Data)
      await assertReconcileRestoration(db, original, parsed as Data)
      await assertContinuationVerified(db, original, parsed as Data)
      assertGoalImpacts(original, parsed as Data)
      if (awaitingGrade) {
        const evidence = parsed.evidence as Data[]
        if (new Set(evidence.map((item) => item.id)).size !== evidence.length)
          throw new Error('The grader needs a distinct ID for each piece of evidence')
        await assertPublishableEvidence(db, g.id, evidence, c.policy.freshness_ms, Date.now())
      }
      if (original.role === 'grade') {
        const input = JSON.parse(original.input) as Data
        if (input.operation === 'result_acceptance')
          resolveEvidenceIds(input, parsed.evidence_ids as string[], 'Grade references unsupplied evidence')
      }
      r.parsed = json(parsed)
    } catch (e) {
      await invalidateResult(db, g, r, a, t, e)
      continue
    }
    await commit(db, g, 'validated', r.id, {}, [
      sql(db, 'UPDATE graph_results SET parsed=?,status=? WHERE id=?', r.parsed, awaitingGrade ? 'received' : 'review', r.id),
      awaitingGrade
        ? sql(db, "UPDATE graph_assignments SET status='grading' WHERE id IN (?,?)", a.id, original.id)
        : sql(db, "UPDATE graph_assignments SET status='review' WHERE id=?", a.id),
      ...(awaitingGrade && a.role === 'repair' ? rebindExecutionReview(db, original.id, r.id) : []),
      sql(db, 'DELETE FROM graph_reservations WHERE attempt_id=?', t.id)
    ])
    if (awaitingGrade) continue
    r.status = 'review'
    if (c.policy.review !== true) {
      try {
        await accept(db, g, r, [], semantic)
      } catch (e) {
        await commit(db, g, 'acceptance_blocked', r.id, { error: String(e) }, [
          sql(db, 'UPDATE graph_results SET validation_error=? WHERE id=?', String(e), r.id)
        ])
      }
    }
  }
}

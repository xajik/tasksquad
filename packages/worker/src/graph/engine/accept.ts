import type { SemanticIndex } from '../dedup.js'
import { type Role } from '../contracts.js'
import { assignment, commit, configuration, id, sql, type Data, type Graph, type Result } from '../store.js'
import { assertEvidenceResources, assertPublishableEvidence } from './assertions.js'
import { resolve } from './results.js'

import { acceptDecompose } from './accept/decompose.js'
import { acceptPlan } from './accept/plan.js'
import { acceptMerge } from './accept/merge.js'
import { acceptExecute } from './accept/execute.js'
import { acceptReview } from './accept/review.js'
import { acceptUndo } from './accept/undo.js'
import { acceptContinue } from './accept/continue.js'
import { acceptReconcile } from './accept/reconcile.js'
import type { AcceptCtx } from './accept/context.js'

export async function evidenceStatements(
  db: D1Database,
  g: Graph,
  r: Result,
  node: string,
  items: Data[],
  storedIds?: Map<string, string>
): Promise<D1PreparedStatement[]> {
  const c = await configuration(db, g),
    now = Date.now(),
    ops: D1PreparedStatement[] = []
  await assertPublishableEvidence(db, g.id, items, c.policy.freshness_ms, now)
  for (const e of items) {
    // Agents pick evidence IDs, but the primary key is global: a later step reusing "ev1" must not
    // block acceptance. Downstream readers take IDs from the stored rows, so mint a fresh one.
    let evidenceId = String(e.id)
    if (await sql(db, 'SELECT id FROM graph_evidence WHERE id=?', evidenceId).first()) evidenceId = id()
    storedIds?.set(String(e.id), evidenceId)
    ops.push(
      sql(
        db,
        'INSERT INTO graph_evidence(id,graph_id,node_id,source_result_id,predicate,value,scope,observed_at,expires_at,resource_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        evidenceId,
        g.id,
        node,
        r.id,
        e.predicate,
        e.value,
        e.scope,
        e.observed_at,
        e.expires_at,
        e.resource_id,
        now
      )
    )
  }
  return ops
}

export async function acceptanceContext(
  db: D1Database,
  g: Graph,
  r: Result,
  ops: D1PreparedStatement[],
  expectedStatus: 'received' | 'review',
  semantic?: SemanticIndex
): Promise<AcceptCtx> {
  const { a, original } = await resolve(db, r),
    c = await configuration(db, g)
  if (r.status !== expectedStatus || original.config_version !== c.version || !r.parsed)
    throw new Error('Result no longer eligible')
  const d = JSON.parse(r.parsed) as Data,
    input = JSON.parse(original.input) as Data
  if (['execute', 'undo', 'reconcile'].includes(original.role)) {
    assertEvidenceResources(original, d)
  }
  ops.push(
    sql(db, "UPDATE graph_results SET status='accepted',accepted_at=? WHERE id=?", Date.now(), r.id),
    sql(db, "UPDATE graph_assignments SET status='accepted' WHERE id IN (?,?)", a.id, original.id),
    ...(a.role === 'repair'
      ? [
          sql(
            db,
            "UPDATE graph_assignments SET status='cancelled' WHERE parent_id=? AND role='continue' AND status='pending'",
            original.id
          )
        ]
      : [])
  )
  const enqueue = async (
    role: Role,
    data: unknown,
    links: { node?: string | null; edge?: string | null; parent?: string | null; priority?: number } = {}
  ) => {
    const next = await assignment(db, g, role, data, { parent: original.id, ...links })
    ops.push(...next.statements)
    return next.id
  }
  return { db, g, r, a, original, c, d, input, ops, enqueue, semantic }
}

export async function accept(
  db: D1Database,
  g: Graph,
  r: Result,
  extra: D1PreparedStatement[] = [],
  semantic?: SemanticIndex
): Promise<void> {
  if (r.status === 'accepted') return
  const x = await acceptanceContext(db, g, r, [...extra], 'review', semantic)
  const { original, ops } = x
  switch (original.role) {
    case 'decompose':
      await acceptDecompose(x)
      break
    case 'plan':
      await acceptPlan(x)
      break
    case 'merge':
      await acceptMerge(x)
      break
    case 'execute':
      await acceptExecute(x)
      break
    case 'grade':
    case 'project':
      await acceptReview(x)
      break
    case 'undo':
      await acceptUndo(x)
      break
    case 'continue':
      await acceptContinue(x)
      break
    case 'reconcile':
      await acceptReconcile(x)
      break
  }
  await commit(db, g, 'accepted', r.id, { role: original.role }, ops)
}

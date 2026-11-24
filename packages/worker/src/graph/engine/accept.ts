import { type Role } from '../contracts.js'
import { assignment, commit, configuration, id, sql, type Data, type Graph, type Result } from '../store.js'
import { assertEvidenceResources } from './assertions.js'
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
  items: Data[]
): Promise<D1PreparedStatement[]> {
  const c = await configuration(db, g),
    now = Date.now(),
    ops: D1PreparedStatement[] = []
  for (const e of items) {
    if (
      typeof e.id !== 'string' ||
      !e.resource_id ||
      !(await sql(
        db,
        'SELECT id FROM graph_resources WHERE id=? AND graph_id=?',
        e.resource_id,
        g.id
      ).first())
    )
      throw new Error('Evidence requires a supplied graph resource')
    if (
      Number(e.observed_at) > now + 60_000 ||
      Number(e.expires_at) <= Number(e.observed_at) ||
      Number(e.expires_at) > Number(e.observed_at) + c.policy.freshness_ms
    )
      throw new Error('Evidence freshness invalid')
    // Agents pick evidence IDs, but the primary key is global: a later step reusing "ev1" must not
    // block acceptance. Downstream readers take IDs from the stored rows, so mint a fresh one.
    let evidenceId = e.id as string
    if (await sql(db, 'SELECT id FROM graph_evidence WHERE id=?', evidenceId).first()) evidenceId = id()
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

export async function accept(
  db: D1Database,
  g: Graph,
  r: Result,
  extra: D1PreparedStatement[] = []
): Promise<void> {
  if (r.status === 'accepted') return
  const { a, original } = await resolve(db, r),
    c = await configuration(db, g)
  if (r.status !== 'review' || original.config_version !== c.version || !r.parsed)
    throw new Error('Result no longer eligible')
  const d = JSON.parse(r.parsed) as Data,
    input = JSON.parse(original.input) as Data
  if (['execute', 'undo', 'reconcile'].includes(original.role)) {
    assertEvidenceResources(original, d)
  }
  const ops: D1PreparedStatement[] = [
    ...extra,
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
  ]
  const enqueue = async (
    role: Role,
    data: unknown,
    links: { node?: string | null; edge?: string | null; parent?: string | null; priority?: number } = {}
  ) => {
    const next = await assignment(db, g, role, data, { parent: original.id, ...links })
    ops.push(...next.statements)
    return next.id
  }
  const x: AcceptCtx = { db, g, r, a, original, c, d, input, ops, enqueue }
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

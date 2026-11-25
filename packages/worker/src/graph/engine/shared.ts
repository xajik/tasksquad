import { type Env } from '../../types.js'
import { type Role } from '../contracts.js'
import { actionLedger } from '../dedup.js'
import { rows, sql, type Assignment, type Data } from '../store.js'

export type GraphEnv = Pick<Env, 'DB'> & {
  POLL_CACHE: Pick<KVNamespace, 'put'>
  ACTION_GRAPH_ENABLED?: string
  GRAPH_AI?: Env['GRAPH_AI']
  GRAPH_VECTORS?: Env['GRAPH_VECTORS']
}

export const actionable = (role: Role) => role === 'execute' || role === 'undo'

/** Follows `continue` parents to the step the owner is really answering. `missing` flags a dangling parent. */
export async function continuationRoot(
  db: D1Database,
  start: Assignment,
  graphId?: string
): Promise<{ root: Assignment; missing: boolean }> {
  let root = start
  const seen = new Set<string>()
  while (root.role === 'continue' && root.parent_id && !seen.has(root.id)) {
    seen.add(root.id)
    const parent = graphId
      ? await sql(db, 'SELECT * FROM graph_assignments WHERE id=? AND graph_id=?', root.parent_id, graphId).first<Assignment>()
      : await sql(db, 'SELECT * FROM graph_assignments WHERE id=?', root.parent_id).first<Assignment>()
    if (!parent) return { root, missing: true }
    root = parent
  }
  return { root, missing: false }
}

/** Restarted steps retain the answers on every earlier execution of that step. */
export async function restartOwnerHistory(db: D1Database, graphId: string, root: Assignment): Promise<string[]> {
  const inputs: string[] = [], seen = new Set<string>()
  let prior: Assignment | null = root
  while (prior && prior.role === root.role && !seen.has(prior.id)) {
    seen.add(prior.id)
    const text = JSON.parse(prior.input).user_input
    if (typeof text === 'string' && text) inputs.unshift(text)
    prior = prior.parent_id
      ? await sql(db, 'SELECT * FROM graph_assignments WHERE id=? AND graph_id=?', prior.parent_id, graphId).first<Assignment>()
      : null
  }
  return inputs
}

export function compactOwnerHistory(inputs: string[]): string[] {
  const separator = '\n\nFollow-up:\n'
  return inputs.filter((text, index) =>
    text && !inputs.slice(index + 1).some((later) =>
      (separator + later + separator).includes(separator + text + separator)
    )
  )
}

export function retryDelay(attempt: number, random = Math.random()): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 480_000) * (0.8 + random * 0.4)
}

export async function executionResources(db: D1Database, graphId: string): Promise<Data[]> {
  return rows(
    db,
    "SELECT id,version,title,description,body FROM graph_resources WHERE graph_id=? AND visibility='execution'",
    graphId
  )
}

export async function executionNodes(db: D1Database, graphId: string): Promise<Data[]> {
  return rows(
    db,
    `SELECT n.id,n.kind,n.title,n.description,n.body,n.source_result_id,s.state
     FROM graph_nodes n JOIN graph_node_states s ON s.id=(SELECT MAX(id) FROM graph_node_states WHERE node_id=n.id)
     WHERE n.graph_id=? AND s.state='active' AND
       (n.kind='observed' OR EXISTS(SELECT 1 FROM graph_results r
        JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id
        WHERE r.id=n.source_result_id AND r.status='accepted' AND a.role IN ('execute','undo')))`,
    graphId
  )
}

export async function executedLineage(db: D1Database, graphId: string, first: string | null): Promise<string[]> {
  const lineage = new Set<string>()
  let edge = first
  while (edge && !lineage.has(edge)) {
    lineage.add(edge)
    const previous = await sql(
      db,
      `SELECT a.edge_id FROM graph_edges e
   JOIN graph_nodes n ON n.id=e.from_id JOIN graph_results r ON r.id=n.source_result_id
   JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id
   WHERE e.id=? AND e.graph_id=? AND a.role='execute' AND r.status='accepted'`,
      edge,
      graphId
    ).first<{ edge_id: string | null }>()
    edge = previous?.edge_id ?? null
  }
  return [...lineage]
}

/** What every planner sees: current states and resources, plus every action already tried or under review. */
export async function planContext(db: D1Database, graphId: string): Promise<Data> {
  return {
    observations: await executionNodes(db, graphId),
    resources: await executionResources(db, graphId),
    attempted_actions: await actionLedger(db, graphId)
  }
}

// Deterministic duplicate detection and shared "what was already tried" knowledge for planning,
// merge review and grading. Agents reword the same idea every time, so identity is never exact text.
import { hash } from './contracts.js'
import { rows, type Data } from './store.js'

/** Same action at or above this token similarity (and the same resources) is a duplicate without asking a reviewer. */
export const AUTO_DUPLICATE = 0.65
/** Candidates at or above this similarity are handed to the merge reviewer as near-duplicates. */
export const NEAR_DUPLICATE = 0.4
/** Open (pending/uncertain) proposals tolerated from a single state before further ones are dropped. */
export const MAX_OPEN_PROPOSALS_PER_STATE = 3
const LEDGER_LIMIT = 30

export const normalizeText = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'are', 'was', 'not'])
/** Crude suffix stripping so retry/retries/retried and chunk/chunks compare equal. */
const stem = (t: string) =>
  t
    .replace(/(ies|ied)$/, 'y')
    .replace(/(ing|ed|es|s)$/, '')
export const tokens = (value: unknown): Set<string> =>
  new Set(
    normalizeText(value)
      .split(' ')
      .filter((t) => t.length > 2 && !STOP.has(t))
      .map(stem)
  )

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const t of a) if (b.has(t)) shared++
  return shared / (a.size + b.size - shared)
}

const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])
const sortedNormalized = (value: unknown) =>
  list(value)
    .map(normalizeText)
    .filter(Boolean)
    .sort()

/** Text that describes what an action does, independent of its title wording. */
export const actionText = (a: Data): string =>
  [a.title, ...list(a.effects), ...list(a.steps)].join(' ')

/** Stable identity of an action: same source state, same resources, same normalized effects. */
export async function fingerprint(a: Data): Promise<string> {
  return hash(
    JSON.stringify([
      String(a.from_id),
      [...list(a.resource_versions)].sort(),
      sortedNormalized(a.effects),
      a.effects && list(a.effects).length ? [] : sortedNormalized(a.steps)
    ])
  )
}

export interface LedgerEntry {
  edge_id: string
  from_id: string
  title: string
  effects: string[]
  status: string
  outcome?: string
  failure?: string
  local_score: number | null
  goal_score: number | null
}

const parseList = (value: unknown): string[] => {
  try {
    return list(JSON.parse(String(value)))
  } catch {
    return []
  }
}

/** Every action the graph has tried or is considering, with how it went. Shared by plan, merge and review inputs. */
export async function actionLedger(db: D1Database, graphId: string, limit = LEDGER_LIMIT): Promise<Data> {
  const edges = await rows<Data>(
    db,
    `SELECT e.id AS edge_id,e.from_id,e.title,p.effects,
      (SELECT a.status FROM graph_assignments a WHERE a.edge_id=e.id AND a.role='execute' ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS status,
      (SELECT json_extract(r.parsed,'$.outcome') FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id
        WHERE a.edge_id=e.id AND a.role='execute' AND r.status='accepted' ORDER BY r.accepted_at DESC LIMIT 1) AS outcome,
      (SELECT substr(json_extract(r.parsed,'$.body'),1,240) FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id
        WHERE a.edge_id=e.id AND a.role='execute' AND r.status='accepted' AND json_extract(r.parsed,'$.outcome') IN ('failed','blocked') ORDER BY r.accepted_at DESC LIMIT 1) AS failure,
      (SELECT AVG(local_score) FROM graph_evaluations v WHERE v.edge_id=e.id) AS local_score,
      (SELECT MAX(goal_score) FROM graph_evaluations v WHERE v.edge_id=e.id) AS goal_score
     FROM graph_edges e JOIN graph_plans p ON p.edge_id=e.id
     WHERE e.graph_id=? ORDER BY e.created_at DESC,e.id DESC LIMIT ?`,
    graphId,
    limit + 1
  )
  const proposals = await rows<{ content: string; status: string }>(
    db,
    "SELECT content,status FROM graph_proposals WHERE graph_id=? AND status IN ('pending','uncertain','rejected') ORDER BY created_at DESC LIMIT ?",
    graphId,
    limit
  )
  const entries: LedgerEntry[] = edges.slice(0, limit).map((e) => ({
    edge_id: String(e.edge_id),
    from_id: String(e.from_id),
    title: String(e.title),
    effects: parseList(e.effects),
    status: String(e.status ?? 'planned'),
    ...(e.outcome ? { outcome: String(e.outcome) } : {}),
    ...(e.failure ? { failure: String(e.failure) } : {}),
    local_score: e.local_score == null ? null : Number(e.local_score),
    goal_score: e.goal_score == null ? null : Number(e.goal_score)
  }))
  const considered = proposals.flatMap((p) => {
    try {
      const c = JSON.parse(p.content) as Data
      return c.from_id
        ? [{ from_id: String(c.from_id), title: String(c.title), effects: list(c.effects), status: `proposal_${p.status}` }]
        : []
    } catch {
      return []
    }
  })
  return {
    actions: entries,
    proposals: considered,
    ...(edges.length > limit ? { omitted_older_actions: true } : {})
  }
}

export interface Candidate {
  edge_id: string
  from_id: string
  title: string
  effects: string[]
  similarity: number
}

/** Existing actions that read like `action`, best first. Only same-source actions can be automatic duplicates. */
export async function nearDuplicates(db: D1Database, graphId: string, action: Data): Promise<Candidate[]> {
  const mine = tokens(actionText(action))
  const resources = JSON.stringify([...list(action.resource_versions)].sort())
  const found = await rows<Data>(
    db,
    `SELECT e.id AS edge_id,e.from_id,e.title,p.effects,p.steps,p.resource_versions
     FROM graph_edges e JOIN graph_plans p ON p.edge_id=e.id WHERE e.graph_id=?`,
    graphId
  )
  return found
    .map((e) => {
      const sameSource = e.from_id === action.from_id
      const sameResources = JSON.stringify([...parseList(e.resource_versions)].sort()) === resources
      const sim = jaccard(mine, tokens(actionText({ title: e.title, effects: parseList(e.effects), steps: parseList(e.steps) })))
      return {
        edge_id: String(e.edge_id),
        from_id: String(e.from_id),
        title: String(e.title),
        effects: parseList(e.effects),
        similarity: Math.round(sim * 100) / 100,
        automatic: sameSource && sameResources
      }
    })
    .filter((c) => c.similarity >= NEAR_DUPLICATE)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
    .map(({ automatic, ...c }) => ({ ...c, ...(automatic ? {} : { similarity: Math.min(c.similarity, AUTO_DUPLICATE - 0.01) }) }))
}

/** Duplicate by identity: exact fingerprint hit, or near-identical same-source same-resource text. */
export async function findDuplicate(db: D1Database, graphId: string, action: Data): Promise<string | null> {
  const fp = await fingerprint(action)
  const hit = await rows<{ edge_id: string }>(
    db,
    'SELECT p.edge_id FROM graph_plans p JOIN graph_edges e ON e.id=p.edge_id WHERE p.fingerprint=? AND e.graph_id=? LIMIT 1',
    fp,
    graphId
  )
  if (hit.length) return hit[0].edge_id
  const near = (await nearDuplicates(db, graphId, action))[0]
  return near && near.similarity >= AUTO_DUPLICATE ? near.edge_id : null
}

/** Open proposals already waiting on one source state. */
export async function openProposals(db: D1Database, graphId: string, fromId: string): Promise<number> {
  const r = await rows<{ content: string }>(
    db,
    "SELECT content FROM graph_proposals WHERE graph_id=? AND status IN ('pending','uncertain')",
    graphId
  )
  return r.filter((p) => {
    try {
      return (JSON.parse(p.content) as Data).from_id === fromId
    } catch {
      return false
    }
  }).length
}

/** Milestone duplicates: same parent and near-identical title/body. */
export async function similarMilestone(
  db: D1Database,
  graphId: string,
  candidate: Data
): Promise<{ id: string; similarity: number }[]> {
  const mine = tokens(`${candidate.title} ${candidate.body}`)
  const found = await rows<Data>(
    db,
    `SELECT n.id,n.title,n.body FROM graph_nodes n WHERE n.graph_id=? AND n.kind='milestone' AND n.parent_id IS ?
     AND (SELECT state FROM graph_node_states WHERE node_id=n.id ORDER BY id DESC LIMIT 1)='active'`,
    graphId,
    candidate.parent_id ?? null
  )
  return found
    .map((n) => ({ id: String(n.id), similarity: Math.round(jaccard(mine, tokens(`${n.title} ${n.body}`)) * 100) / 100 }))
    .filter((n) => n.similarity >= NEAR_DUPLICATE)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
}

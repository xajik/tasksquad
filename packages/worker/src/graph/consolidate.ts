// One-off and on-resume cleanup of duplicate actions that predate fingerprinting. History is never rewritten:
// executed or started actions stay; only unstarted duplicates are cancelled and their unreached target states retired.
import { AUTO_DUPLICATE, fingerprint, jaccard, tokens, actionText } from './dedup.js'
import { commit, rows, sql, type Data, type Graph } from './store.js'

interface Row {
  id: string
  from_id: string
  to_id: string
  title: string
  fingerprint: string | null
  effects: string
  steps: string
  resource_versions: string
  executed: number
  started: number
  unstarted: number
}

const parse = (v: string): string[] => {
  try {
    const x = JSON.parse(v)
    return Array.isArray(x) ? x.map(String) : []
  } catch {
    return []
  }
}

export async function consolidateDuplicates(db: D1Database, g: Graph): Promise<{ kept: number; retired: number }> {
  const edges = await rows<Row>(
    db,
    `SELECT e.id,e.from_id,e.to_id,e.title,p.fingerprint,p.effects,p.steps,p.resource_versions,
      EXISTS(SELECT 1 FROM graph_assignments a JOIN graph_attempts t ON t.assignment_id=a.id JOIN graph_results r ON r.attempt_id=t.id
        WHERE a.edge_id=e.id AND a.role='execute' AND r.status='accepted') AS executed,
      EXISTS(SELECT 1 FROM graph_assignments a WHERE a.edge_id=e.id AND a.role='execute' AND a.attempt_count>0) AS started,
      EXISTS(SELECT 1 FROM graph_assignments a WHERE a.edge_id=e.id AND a.role='execute' AND a.status='pending' AND a.attempt_count=0) AS unstarted
     FROM graph_edges e JOIN graph_plans p ON p.edge_id=e.id WHERE e.graph_id=?
     ORDER BY executed DESC,started DESC,e.created_at,e.id`,
    g.id
  )
  const heads: { row: Row; text: Set<string>; resources: string; fp: string }[] = []
  const ops: D1PreparedStatement[] = []
  let retired = 0
  for (const row of edges) {
    const action: Data = {
      from_id: row.from_id,
      title: row.title,
      effects: parse(row.effects),
      steps: parse(row.steps),
      resource_versions: parse(row.resource_versions)
    }
    const fp = await fingerprint(action)
    const resources = JSON.stringify([...parse(row.resource_versions)].sort())
    const text = tokens(actionText(action))
    const head = heads.find(
      (h) =>
        h.row.from_id === row.from_id &&
        h.resources === resources &&
        (h.fp === fp || jaccard(h.text, text) >= AUTO_DUPLICATE)
    )
    if (!head) {
      heads.push({ row, text, resources, fp })
      continue
    }
    // Free the fingerprint so the surviving action can own it.
    ops.push(sql(db, 'UPDATE graph_plans SET fingerprint=NULL WHERE edge_id=?', row.id))
    if (row.unstarted && !row.started && !row.executed) {
      retired++
      ops.push(
        sql(
          db,
          "UPDATE graph_assignments SET status='cancelled',cancel_reason='duplicate' WHERE edge_id=? AND role='execute' AND status='pending' AND attempt_count=0",
          row.id
        ),
        sql(
          db,
          "INSERT INTO graph_node_states(graph_id,node_id,state,reason,created_at) VALUES(?,?,'deactivated','duplicate',?)",
          g.id,
          row.to_id,
          Date.now()
        )
      )
    }
  }
  let kept = 0
  for (const h of heads)
    if (!h.row.fingerprint) {
      kept++
      ops.push(sql(db, 'UPDATE graph_plans SET fingerprint=? WHERE edge_id=? AND fingerprint IS NULL', h.fp, h.row.id))
    }
  if (ops.length) await commit(db, g, 'dedup', null, { retired, stamped: kept }, ops)
  return { kept, retired }
}

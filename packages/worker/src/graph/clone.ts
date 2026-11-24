import { type Graph, type Data, id, sql, rows, graph, configuration, create } from './store.js'

// Clone a closed graph: always the goal, start state, policy and success rule (fresh start);
// optionally the node/edge structure with plans, resources and tags (no results, evidence or history).
export async function clone(
  db: D1Database,
  teamId: string,
  userId: string,
  sourceId: string,
  withNodes: boolean
): Promise<Graph> {
  const src = await graph(db, sourceId)
  if (src.team_id !== teamId) throw new Error('Graph not found')
  if (src.status !== 'stopped') throw new Error('Only closed graphs can be cloned')
  const c = await configuration(db, src)
  const g = await create(db, teamId, userId, {
    title: `${src.title} (copy)`.slice(0, 299),
    description: src.description,
    body: src.body,
    start_state: src.start_state,
    policy: c.policy,
    rule: c.rule
  })
  if (!withNodes) return g
  const map = new Map<string, string>()
  const fresh = await rows<{ id: string; kind: string }>(
    db,
    "SELECT id,kind FROM graph_nodes WHERE graph_id=? AND kind IN ('observed','goal')",
    g.id
  )
  for (const k of ['observed', 'goal']) {
    const from = await db
      .prepare('SELECT id FROM graph_nodes WHERE graph_id=? AND kind=? ORDER BY created_at LIMIT 1')
      .bind(sourceId, k)
      .first<{ id: string }>()
    const to = fresh.find((n) => n.kind === k)
    if (from && to) map.set(from.id, to.id)
  }
  const nodes = await rows<Data>(
    db,
    "SELECT * FROM graph_nodes WHERE graph_id=? AND kind NOT IN ('observed','goal') ORDER BY created_at,rowid",
    sourceId
  )
  const edges = await rows<Data>(
    db,
    'SELECT * FROM graph_edges WHERE graph_id=? ORDER BY created_at',
    sourceId
  )
  const plans = await rows<Data>(
    db,
    'SELECT p.* FROM graph_plans p JOIN graph_edges e ON e.id=p.edge_id WHERE e.graph_id=?',
    sourceId
  )
  const resources = await rows<Data>(
    db,
    'SELECT * FROM graph_resources WHERE graph_id=? ORDER BY created_at',
    sourceId
  )
  const links = await rows<Data>(
    db,
    'SELECT l.* FROM graph_resource_links l JOIN graph_resources r ON r.id=l.resource_id WHERE r.graph_id=?',
    sourceId
  )
  const tags = await rows<Data>(db, 'SELECT * FROM graph_tags WHERE graph_id=?', sourceId)
  for (const n of nodes) map.set(n.id as string, id())
  const resMap = new Map<string, string>()
  for (const r of resources) resMap.set(r.id as string, id())
  const now = Date.now(),
    ops: D1PreparedStatement[] = []
  for (const n of nodes)
    ops.push(
      sql(
        db,
        'INSERT INTO graph_nodes(id,graph_id,kind,title,description,body,parent_id,source_result_id,necessity,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        map.get(n.id as string),
        g.id,
        n.kind,
        n.title,
        n.description,
        n.body,
        n.parent_id ? (map.get(n.parent_id as string) ?? null) : null,
        n.source_result_id,
        n.necessity,
        now
      ),
      sql(
        db,
        "INSERT INTO graph_node_states(graph_id,node_id,state,created_at) VALUES(?,?,'active',?)",
        g.id,
        map.get(n.id as string),
        now
      )
    )
  const edgeMap = new Map<string, string>()
  for (const e of edges) {
    const from = map.get(e.from_id as string),
      to = map.get(e.to_id as string)
    if (!from || !to) continue
    edgeMap.set(e.id as string, id())
    ops.push(
      sql(
        db,
        'INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at,expected_score) VALUES(?,?,?,?,?,?,?,?,?,?)',
        edgeMap.get(e.id as string),
        g.id,
        from,
        to,
        e.title,
        e.description,
        e.body,
        e.source_result_id,
        now,
        e.expected_score ?? null
      )
    )
  }
  for (const p of plans) {
    const edge = edgeMap.get(p.edge_id as string)
    if (edge)
      ops.push(
        sql(
          db,
          'INSERT INTO graph_plans(edge_id,baseline,predicates,steps,undo_steps,cost,recovery_cost,resource_versions,effects) VALUES(?,?,?,?,?,?,?,?,?)',
          edge,
          p.baseline,
          p.predicates,
          p.steps,
          p.undo_steps,
          p.cost,
          p.recovery_cost,
          p.resource_versions,
          p.effects
        )
      )
  }
  for (const r of resources)
    ops.push(
      sql(
        db,
        'INSERT INTO graph_resources(id,graph_id,version,title,description,body,visibility,r2_key,created_at,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
        resMap.get(r.id as string),
        g.id,
        r.version,
        r.title,
        r.description,
        r.body,
        r.visibility,
        r.r2_key,
        now,
        r.supersedes_id ? (resMap.get(r.supersedes_id as string) ?? null) : null
      )
    )
  for (const l of links) {
    const r = resMap.get(l.resource_id as string),
      n = map.get(l.node_id as string)
    if (r && n) ops.push(sql(db, 'INSERT INTO graph_resource_links(resource_id,node_id) VALUES(?,?)', r, n))
  }
  for (const t of tags) {
    const n = map.get(t.node_id as string)
    if (n) ops.push(sql(db, 'INSERT INTO graph_tags(graph_id,node_id,tag) VALUES(?,?,?)', g.id, n, t.tag))
  }
  for (let i = 0; i < ops.length; i += 90) await db.batch(ops.slice(i, i + 90))
  return g
}

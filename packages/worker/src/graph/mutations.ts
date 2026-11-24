import { type Data, id, sql, graph, commit } from './store.js'

export async function resource(db: D1Database, graphId: string, body: Data): Promise<void> {
  const g = await graph(db, graphId)
  for (const [key, max] of [
    ['title', 299],
    ['description', 299],
    ['body', 3999]
  ] as const)
    if (typeof body[key] !== 'string' || [...(body[key] as string).normalize('NFC')].length > max)
      throw new Error(`Invalid resource ${key}`)
  if (!['execution', 'private'].includes(body.visibility as string)) throw new Error('Invalid visibility')
  const prior = body.supersedes_id
    ? await sql(
        db,
        'SELECT id,version FROM graph_resources WHERE id=? AND graph_id=?',
        body.supersedes_id,
        g.id
      ).first<{ id: string; version: number }>()
    : null
  if (body.supersedes_id && !prior) throw new Error('Previous resource version outside graph')
  const resourceId = id()
  await commit(db, g, 'resource', resourceId, {}, [
    sql(
      db,
      'INSERT INTO graph_resources(id,graph_id,version,title,description,body,visibility,created_at,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?)',
      resourceId,
      g.id,
      (prior?.version ?? 0) + 1,
      body.title,
      body.description,
      body.body,
      body.visibility,
      Date.now(),
      prior?.id ?? null
    )
  ])
}

export async function annotate(
  db: D1Database,
  graphId: string,
  kind: 'tag' | 'link',
  body: Data
): Promise<void> {
  const g = await graph(db, graphId)
  if (!(await sql(db, 'SELECT id FROM graph_nodes WHERE id=? AND graph_id=?', body.node_id, g.id).first()))
    throw new Error('Node outside graph')
  let operation: D1PreparedStatement
  if (kind === 'tag') {
    if (
      typeof body.tag !== 'string' ||
      ![...body.tag.normalize('NFC')].length ||
      [...body.tag.normalize('NFC')].length > 99
    )
      throw new Error('Invalid tag')
    operation = sql(
      db,
      'INSERT OR IGNORE INTO graph_tags(graph_id,node_id,tag) VALUES(?,?,?)',
      g.id,
      body.node_id,
      body.tag.normalize('NFC')
    )
  } else {
    if (
      !(await sql(
        db,
        'SELECT id FROM graph_resources WHERE id=? AND graph_id=?',
        body.resource_id,
        g.id
      ).first())
    )
      throw new Error('Resource outside graph')
    operation = sql(
      db,
      'INSERT OR IGNORE INTO graph_resource_links(resource_id,node_id) VALUES(?,?)',
      body.resource_id,
      body.node_id
    )
  }
  await commit(db, g, kind, String(body.node_id), body, [operation])
}

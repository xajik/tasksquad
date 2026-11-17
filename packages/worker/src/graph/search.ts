import type { Env } from '../types.js'
import { sql, rows, type Data, type Graph } from './store.js'

/** Vector matches are untrusted hints; rehydrate current graph rows before returning. */
export async function search(
  env: Env,
  g: Graph,
  query: string
): Promise<{ nodes: Data[]; resources: Data[]; edges: Data[] }> {
  const pattern = `%${query.toLowerCase().slice(0, 299)}%`
  const [nodes, resources, edges] = await Promise.all([
    rows<Data>(
      env.DB,
      'SELECT * FROM graph_nodes WHERE graph_id=? AND (lower(title) LIKE ? OR lower(description) LIKE ? OR lower(body) LIKE ? OR id IN (SELECT node_id FROM graph_tags WHERE graph_id=? AND lower(tag) LIKE ?)) LIMIT 100',
      g.id,
      pattern,
      pattern,
      pattern,
      g.id,
      pattern
    ),
    rows<Data>(
      env.DB,
      'SELECT * FROM graph_resources WHERE graph_id=? AND (lower(title) LIKE ? OR lower(description) LIKE ? OR lower(body) LIKE ?) LIMIT 100',
      g.id,
      pattern,
      pattern,
      pattern
    ),
    rows<Data>(
      env.DB,
      'SELECT * FROM graph_edges WHERE graph_id=? AND (lower(title) LIKE ? OR lower(description) LIKE ? OR lower(body) LIKE ?) LIMIT 100',
      g.id,
      pattern,
      pattern,
      pattern
    )
  ])
  if (!query.trim() || !env.GRAPH_AI || !env.GRAPH_VECTORS) return { nodes, resources, edges }
  try {
    const embedded = (await env.GRAPH_AI.run('@cf/baai/bge-base-en-v1.5', {
      text: [query.slice(0, 299)]
    })) as { data: number[][] }
    const found = await env.GRAPH_VECTORS.query(embedded.data[0], {
      namespace: g.team_id,
      topK: 20,
      returnMetadata: 'all',
      filter: { graph_id: g.id, version: g.version }
    })
    for (const match of found.matches) {
      if (
        match.metadata?.graph_id !== g.id ||
        match.metadata?.version !== g.version ||
        typeof match.metadata?.entity_id !== 'string'
      )
        continue
      const entity = match.metadata.entity_id
      for (const [table, target] of [
        ['graph_nodes', nodes],
        ['graph_resources', resources],
        ['graph_edges', edges]
      ] as const) {
        const row = await sql(
          env.DB,
          `SELECT * FROM ${table} WHERE id=? AND graph_id=?`,
          entity,
          g.id
        ).first<Data>()
        if (row && !target.some((r) => r.id === row.id)) target.push(row)
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ event: 'graph_search_fallback', graph_id: g.id, error: String(error) }))
  }
  return { nodes, resources, edges }
}

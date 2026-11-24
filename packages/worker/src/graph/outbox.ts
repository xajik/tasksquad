import { hash } from './contracts.js'
import type { Env } from '../types.js'
import { graph, rows, sql, type Data } from './store.js'
import { snapshot } from './snapshot.js'

export async function materialize(env: Env, graphId: string): Promise<void> {
  const g = await graph(env.DB, graphId),
    now = Date.now()
  const pending = await rows<{ id: number; kind: string; graph_version: number; cursor: number }>(
    env.DB,
    "SELECT id,kind,graph_version,cursor FROM graph_outbox WHERE graph_id=? AND status='pending' AND available_at<=? ORDER BY graph_version DESC LIMIT 10",
    g.id,
    now
  )
  for (const item of pending) {
    if (item.graph_version !== g.version) {
      await sql(env.DB, "UPDATE graph_outbox SET status='superseded' WHERE id=?", item.id).run()
      continue
    }
    try {
      const data = await snapshot(env.DB, g)
      if (item.kind === 'snapshot')
        await env.LOGS.put(`graphs/${g.team_id}/${g.id}/snapshots/${g.version}.json`, JSON.stringify(data), {
          httpMetadata: { contentType: 'application/json' }
        })
      else {
        if (!env.GRAPH_AI || !env.GRAPH_VECTORS) continue
        const entities: Data[] = [
          ...(data.nodes as Data[]).map((n) => ({
            ...n,
            visibility: n.kind === 'goal' || n.kind === 'milestone' ? 'private' : 'execution'
          })),
          ...(data.resources as Data[]),
          ...(data.edges as Data[]).map((e) => ({ ...e, visibility: 'execution' }))
        ]
        const work = entities.flatMap((entity) =>
          embeddingChunks(
            [
              entity.title,
              entity.description,
              entity.body,
              ...(Array.isArray(entity.tags) ? entity.tags : [])
            ].join('\n')
          ).map((text, index) => ({ entity, text, index }))
        )
        const end = Math.min(work.length, item.cursor + 12)
        for (let cursor = item.cursor; cursor < end; cursor++) {
          const { entity, text, index } = work[cursor]
          const cacheKey = `graphs/${g.team_id}/${g.id}/embeddings/bge-base-en-v1.5/${await hash(text)}.json`
          const cached = await env.LOGS.get(cacheKey)
          const output = cached
            ? await cached.json<{ data: number[][] }>()
            : ((await env.GRAPH_AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] })) as {
                data: number[][]
              })
          if (
            !output.data?.[0] ||
            output.data[0].length !== 768 ||
            output.data[0].some((n) => !Number.isFinite(n))
          )
            throw new Error('Invalid embedding output')
          if (!cached) await env.LOGS.put(cacheKey, JSON.stringify(output))
          await env.GRAPH_VECTORS.upsert([
            {
              id: `${entity.id}:${g.version}:${index}`,
              values: output.data[0],
              namespace: g.team_id,
              metadata: {
                graph_id: g.id,
                version: g.version,
                visibility: String(entity.visibility),
                entity_id: String(entity.id)
              }
            }
          ])
          await sql(env.DB, 'UPDATE graph_outbox SET cursor=? WHERE id=?', cursor + 1, item.id).run()
        }
        if (end < work.length) continue
      }
      await sql(env.DB, "UPDATE graph_outbox SET status='done',error=NULL WHERE id=?", item.id).run()
    } catch (e) {
      await sql(
        env.DB,
        'UPDATE graph_outbox SET attempts=attempts+1,error=?,available_at=? WHERE id=?',
        String(e),
        now + 60_000,
        item.id
      ).run()
    }
  }
}

/** UTF-8 byte bounds are conservative for the model's 512-token input limit. */
export function embeddingChunks(text: string, maxBytes = 384): string[] {
  const chunks: string[] = []
  let chunk = '',
    bytes = 0
  for (const scalar of text) {
    const length = new TextEncoder().encode(scalar).length
    if (bytes + length > maxBytes && chunk) {
      chunks.push(chunk)
      chunk = ''
      bytes = 0
    }
    chunk += scalar
    bytes += length
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

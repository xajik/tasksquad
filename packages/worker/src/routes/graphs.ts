import type { Env, AuthContext } from '../types.js'
import { json, err } from '../auth.js'
import { requireMember, requireMaintainer } from './helpers.js'
import { search } from '../graph/search.js'
import { clone, create, graph, snapshot, rows, type Data } from '../graph/store.js'

export async function handle(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  auth: AuthContext
): Promise<Response> {
  const parts = new URL(req.url).pathname.split('/'),
    teamId = parts[2],
    graphId = parts[4],
    action = parts[5]
  if (
    env.ACTION_GRAPH_ENABLED !== 'true' &&
    req.method !== 'GET' &&
    !['pause', 'stop', 'review', 'input', 'fail', 'abandon'].includes(action)
  )
    return err('graph_dispatch_disabled', 409)
  const write = req.method !== 'GET'
  if (!(await (write ? requireMaintainer : requireMember)(env.DB, teamId, auth.userId)))
    return err('forbidden', 403)
  try {
    if (!graphId) {
      if (req.method === 'GET')
        return json({
          graphs: await rows(env.DB, 'SELECT * FROM graphs WHERE team_id=? ORDER BY created_at DESC', teamId)
        })
      if (req.method === 'POST') {
        const g = await create(env.DB, teamId, auth.userId, await boundedJSON(req))
        return json(g, 201)
      }
      return err('method_not_allowed', 405)
    }
    const g = await graph(env.DB, graphId)
    if (g.team_id !== teamId) return err('not_found', 404)
    if (req.method === 'GET') {
      if (action === 'search') return json(await search(env, g, new URL(req.url).searchParams.get('q') ?? ''))
      return json(await snapshot(env.DB, g, env.ACTION_GRAPH_ENABLED === 'true', true))
    }
    if (req.method !== 'POST') return err('method_not_allowed', 405)
    const body = await boundedJSON(req)
    if (action === 'clone') {
      const copy = await clone(env.DB, teamId, auth.userId, graphId, body.with_nodes === true)
      return json(copy, 201)
    }
    const coordinator = env.GRAPH_COORDINATOR.get(env.GRAPH_COORDINATOR.idFromName(teamId))
    if (action === 'resource') {
      // Resources are immutable versions. These owner mutations also use coordinator serialization.
      await coordinator.command(graphId, 'resource', { ...body, user_id: auth.userId, team_id: teamId })
    } else
      await coordinator.command(graphId, action ?? '', { ...body, user_id: auth.userId, team_id: teamId })
    return json({ ok: true })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400)
  }
}

export async function boundedJSON(req: Request): Promise<Data> {
  const reader = req.body?.getReader()
  if (!reader) return {}
  const decoder = new TextDecoder(),
    chunks: string[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > 128 * 1024) {
      await reader.cancel()
      throw new Error('Request too large')
    }
    chunks.push(decoder.decode(value, { stream: true }))
  }
  chunks.push(decoder.decode())
  const parsed = JSON.parse(chunks.join('') || '{}')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected object')
  return parsed
}

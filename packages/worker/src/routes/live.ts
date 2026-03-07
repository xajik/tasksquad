import { err, verifyTokenString } from '../auth.js'
import type { Env } from '../types.js'

// SSE endpoint — EventSource cannot send Authorization header, so we accept
// the Firebase JWT via ?token= query param as well.
export async function connect(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.pathname.split('/')[2]

  // Auth: prefer Authorization header, fall back to ?token= query param
  const rawToken =
    req.headers.get('Authorization')?.slice(7) ??
    url.searchParams.get('token') ??
    ''
  if (!rawToken) return err('unauthorized', 401)

  const auth = await verifyTokenString(rawToken, env)
  if (!auth) return err('invalid_token', 401)

  // Verify agent exists and user is a member of its team
  const agent = await env.DB
    .prepare('SELECT team_id FROM agents WHERE id = ?')
    .bind(agentId)
    .first<{ team_id: string }>()
  if (!agent) return err('not_found', 404)

  const member = await env.DB
    .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
    .bind(agent.team_id, auth.userId)
    .first<{ role: string }>()
  if (!member) return err('not_found', 404)

  // Proxy to AgentRelay Durable Object
  const doId = env.AGENT_RELAY.idFromName(agentId)
  const stub = env.AGENT_RELAY.get(doId)
  return stub.fetch(new Request('https://relay/connect'))
}

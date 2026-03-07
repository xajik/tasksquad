import { err } from '../auth.js'
import type { Env, AuthContext } from '../types.js'

export async function connect(req: Request, env: Env, _ctx: unknown, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url)
  const agentId = url.pathname.split('/')[2]

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

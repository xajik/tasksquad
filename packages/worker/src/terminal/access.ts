import type { Env } from '../types.js'

export interface RelaySession {
  teamId: string
  agentId: string
}

// resolveRelaySession maps a TerminalRelay session id to the team and agent that own it.
// A relay session is either a portal (its session id is always the portal id, pinned by
// portals.daemonOpen) or a task session. The `session_id = id` guard ignores any portal
// row whose session_id was set to something else, so a daemon cannot point its own
// portal at another tenant's session and inherit access to that relay. An id that
// resolves to both kinds is refused rather than guessed at.
export async function resolveRelaySession(env: Pick<Env, 'DB'>, sessionId: string): Promise<RelaySession | null> {
  const [portal, session] = await Promise.all([
    env.DB
      .prepare('SELECT team_id, agent_id FROM portals WHERE id = ? AND session_id = id')
      .bind(sessionId)
      .first<{ team_id: string; agent_id: string }>(),
    env.DB
      .prepare('SELECT t.team_id, s.agent_id FROM sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?')
      .bind(sessionId)
      .first<{ team_id: string; agent_id: string }>(),
  ])
  if (portal && session) return null
  const row = portal ?? session
  return row ? { teamId: row.team_id, agentId: row.agent_id } : null
}

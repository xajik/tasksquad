import { z } from 'zod'
import { DESTRUCTIVE, READ, WRITE, run, type Register } from './util.js'

const teamId = z.string().describe('Project ID (from list_projects).')
const agentId = z.string().describe('Agent ID (from list_agents).')

export const registerAgents: Register = (server, { api }) => {
  server.registerTool('list_agents', {
    title: 'List agents',
    description: 'List AI agents in a project: id, name, role, status (online/offline from daemon heartbeats), last_seen, paused, reset_pending. Pick an agent_id from here before creating tasks.',
    inputSchema: { team_id: teamId },
    annotations: READ,
  }, ({ team_id }) => run(() => api.listAgents(team_id)))

  server.registerTool('create_agent', {
    title: 'Create agent',
    description: 'Register a new agent in a project. The agent only becomes active once the user connects a daemon to it (tokens must be created by the user in the portal).',
    inputSchema: { team_id: teamId, name: z.string().min(1), role: z.string().optional().describe('Free-text role/instructions describing what this agent is for.') },
    annotations: WRITE,
  }, ({ team_id, name, role }) => run(() => api.createAgent(team_id, { name, role })))

  server.registerTool('update_agent_role', {
    title: 'Update agent role',
    description: "Change an agent's role description.",
    inputSchema: { team_id: teamId, agent_id: agentId, role: z.string() },
    annotations: WRITE,
  }, ({ team_id, agent_id, role }) => run(() => api.updateAgentRole(team_id, agent_id, role)))

  server.registerTool('pause_agent', {
    title: 'Pause or resume agent',
    description: 'Pause (paused=true) or resume (paused=false) an agent. Paused agents do not pick up new tasks.',
    inputSchema: { team_id: teamId, agent_id: agentId, paused: z.boolean() },
    annotations: WRITE,
  }, ({ team_id, agent_id, paused }) => run(() => api.pauseAgent(team_id, agent_id, paused)))

  server.registerTool('reset_agent', {
    title: 'Reset agent',
    description: "Ask the agent's daemon to reset its session state on the next poll (use when an agent is stuck).",
    inputSchema: { team_id: teamId, agent_id: agentId },
    // Discards the agent's current session, which can't be restored.
    annotations: DESTRUCTIVE,
  }, ({ team_id, agent_id }) => run(() => api.resetAgent(team_id, agent_id)))
}

import { z } from 'zod'
import { READ, run, type Register } from './util.js'

const teamId = z.string().describe('Project ID (from list_projects).')

export const registerMemory: Register = (server, { api }) => {
  server.registerTool('list_memory', {
    title: 'List project memory',
    description: 'List shared project memory entries written by agents (titles, tags; content omitted — use get_memory). Read-only.',
    inputSchema: { team_id: teamId, category: z.enum(['personal', 'preferences', 'structure', 'architecture', 'events']).optional() },
    annotations: READ,
  }, ({ team_id, category }) => run(() => api.listMemory(team_id, category)))

  server.registerTool('get_memory', {
    title: 'Get memory entry',
    description: 'Get one project memory entry with its content.',
    inputSchema: { team_id: teamId, memory_id: z.string() },
    annotations: READ,
  }, ({ team_id, memory_id }) => run(() => api.getMemory(team_id, memory_id)))

  server.registerTool('list_memory_rollups', {
    title: 'List memory rollups',
    description: 'Daily or weekly digests summarizing what happened in the project.',
    inputSchema: { team_id: teamId, period: z.enum(['daily', 'weekly']).default('daily') },
    annotations: READ,
  }, ({ team_id, period }) => run(() => api.rollups(team_id, period)))

  server.registerTool('list_tags', {
    title: 'List tags',
    description: 'List tags used across project memory and notes.',
    inputSchema: { team_id: teamId },
    annotations: READ,
  }, ({ team_id }) => run(() => api.listTags(team_id)))
}

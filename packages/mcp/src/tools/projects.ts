import { z } from 'zod'
import { READ, WRITE, run, toMillis, type Register } from './util.js'

const teamId = z.string().describe('Project ID (from list_projects).')

export const registerProjects: Register = (server, { api }) => {
  server.registerTool('whoami', {
    title: 'Current user',
    description: 'Return the signed-in TaskSquad user (id, email, plan). Pro plan unlocks Portals and faster polling.',
    annotations: READ,
    // Lets ChatGPT identify which TaskSquad account is connected.
    _meta: { 'openai/profile': true },
  }, () => run(() => api.me()))

  server.registerTool('list_projects', {
    title: 'List projects',
    description: 'List TaskSquad projects (called "teams" in the API) the user belongs to, with their role and memory/learning settings. Start here: almost every other tool needs a team_id.',
    annotations: READ,
  }, () => run(() => api.listTeams()))

  server.registerTool('create_project', {
    title: 'Create project',
    description: 'Create a new project owned by the user.',
    inputSchema: { name: z.string().min(1) },
    annotations: WRITE,
  }, ({ name }) => run(() => api.createTeam(name)))

  server.registerTool('update_project_settings', {
    title: 'Update project settings',
    description: 'Toggle project-level settings: learn_from_session (agents extract learnings when sessions close) and memory_enabled (shared project memory).',
    inputSchema: { team_id: teamId, learn_from_session: z.boolean().optional(), memory_enabled: z.boolean().optional() },
    annotations: WRITE,
  }, ({ team_id, ...body }) => run(() => api.updateTeam(team_id, body)))

  server.registerTool('list_project_members', {
    title: 'List project members',
    description: 'List human members of a project with their role (owner/maintainer/member). Use member ids to interpret task sender_id fields.',
    inputSchema: { team_id: teamId },
    annotations: READ,
  }, ({ team_id }) => run(() => api.listMembers(team_id)))

  server.registerTool('get_project_stats', {
    title: 'Project analytics',
    description: 'Task and usage analytics for a project over a time range: totals, daily counts, success rate, token/tool usage, top tools and skills, per-agent stats. Defaults to the last 7 days.',
    inputSchema: {
      team_id: teamId,
      from: z.string().optional().describe('Range start, ISO-8601 (default: 7 days ago).'),
      to: z.string().optional().describe('Range end, ISO-8601 (default: now).'),
      agent_id: z.string().optional().describe('Restrict to one agent.'),
      tz_offset_minutes: z.number().int().optional().describe('Timezone offset as returned by JS Date.getTimezoneOffset() (e.g. -120 for UTC+2) used for daily buckets. Default 0 (UTC).'),
    },
    annotations: READ,
  }, ({ team_id, from, to, agent_id, tz_offset_minutes }) => run(() => {
    const end = toMillis(to) ?? Date.now()
    const start = toMillis(from) ?? end - 7 * 24 * 60 * 60 * 1000
    return api.stats(team_id, { from: start, to: end, agentId: agent_id, tzOffsetMinutes: tz_offset_minutes })
  }))
}

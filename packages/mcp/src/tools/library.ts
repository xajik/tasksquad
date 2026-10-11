import { z } from 'zod'
import { READ, WRITE, run, type Register } from './util.js'

const teamId = z.string().describe('Project ID (from list_projects).')
const kind = z.enum(['skills', 'sub-agents', 'commands']).describe(
  'skills = SKILL.md instruction packs; sub-agents = agent definitions; commands = slash commands. All are synced to agents in the project.',
)

export const registerLibrary: Register = (server, { api }) => {
  server.registerTool('list_library', {
    title: 'List skills / sub-agents / commands',
    description: 'List the project library of one kind (content omitted). Items with auto_install are installed on every agent automatically.',
    inputSchema: { team_id: teamId, kind },
    annotations: READ,
  }, ({ team_id, kind: k }) => run(() => api.listLibrary(team_id, k)))

  server.registerTool('get_library_item', {
    title: 'Get skill / sub-agent / command',
    description: 'Get one library item including its full markdown content.',
    inputSchema: { team_id: teamId, kind, id: z.string() },
    annotations: READ,
  }, ({ team_id, kind: k, id }) => run(() => api.getLibraryItem(team_id, k, id)))

  server.registerTool('create_library_item', {
    title: 'Create skill / sub-agent / command',
    description: 'Create a library item. name must be unique per kind within the project.',
    inputSchema: {
      team_id: teamId,
      kind,
      name: z.string().min(1),
      description: z.string(),
      content: z.string().describe('Markdown body (e.g. SKILL.md contents).'),
      auto_install: z.boolean().optional(),
    },
    annotations: WRITE,
  }, ({ team_id, kind: k, ...body }) => run(() => api.createLibraryItem(team_id, k, body)))

  server.registerTool('update_library_item', {
    title: 'Update skill / sub-agent / command',
    description: 'Update a library item. Only provided fields change.',
    inputSchema: {
      team_id: teamId,
      kind,
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      content: z.string().optional(),
      auto_install: z.boolean().optional(),
    },
    annotations: WRITE,
  }, ({ team_id, kind: k, id, ...body }) => run(() => api.updateLibraryItem(team_id, k, id, body)))
}

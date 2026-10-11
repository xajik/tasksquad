import { z } from 'zod'
import { SPECIAL_KEYS, useTerminal, type SpecialKey } from '../terminal.js'
import { DESTRUCTIVE, READ, WRITE, ok, run, type Register } from './util.js'

const teamId = z.string().describe('Project ID (from list_projects).')
const portalId = z.string().describe('Portal ID (from list_portals / open_portal).')
const sessionId = z.string().describe("Live session id: a task's session_id (get_task) or a running portal's session_id (get_portal).")
const waitMs = z.number().int().min(200).max(20000).default(2000).describe('How long to collect output, in ms.')
const maxChars = z.number().int().min(500).max(100000).default(8000).describe('Keep only the last N characters.')

export const registerPortals: Register = (server, { api }) => {
  server.registerTool('list_portals', {
    title: 'List portals',
    description: "List portals in a project. A portal is an interactive terminal (tmux) session on an agent's machine (Pro plan, max 3 concurrent per project).",
    inputSchema: { team_id: teamId },
    annotations: READ,
  }, ({ team_id }) => run(() => api.listPortals(team_id)))

  server.registerTool('get_portal', {
    title: 'Get portal',
    description: 'Get portal status (pending → running → done/failed) and its session_id once running.',
    inputSchema: { portal_id: portalId },
    annotations: READ,
  }, ({ portal_id }) => run(() => api.getPortal(portal_id)))

  server.registerTool('open_portal', {
    title: 'Open portal',
    description: "Open an interactive terminal on an agent's machine. The daemon starts it on its next poll; poll get_portal until status=running, then use read_live_terminal / send_terminal_input with its session_id.",
    inputSchema: { team_id: teamId, agent_id: z.string() },
    annotations: WRITE,
  }, ({ team_id, agent_id }) => run(() => api.createPortal(team_id, agent_id)))

  server.registerTool('close_portal', {
    title: 'Close portal',
    description: 'Close a portal and end its terminal session.',
    inputSchema: { portal_id: portalId },
    annotations: DESTRUCTIVE,
  }, ({ portal_id }) => run(() => api.closePortal(portal_id)))

  server.registerTool('read_live_terminal', {
    title: 'Read live terminal',
    description: 'Snapshot the live terminal of a running task or portal: the recent buffered output plus anything printed during wait_ms, with ANSI codes stripped.',
    inputSchema: { session_id: sessionId, wait_ms: waitMs, max_chars: maxChars },
    annotations: READ,
  }, ({ session_id, wait_ms, max_chars }) => run(async () =>
    ok(await useTerminal(api, session_id, { waitMs: wait_ms, maxChars: max_chars }) || '(no output yet)')))

  server.registerTool('send_terminal_input', {
    title: 'Type into live terminal',
    description: "Type into the live terminal of a running task or portal, exactly as a user would in the portal's terminal (runs on the agent's machine). Sends `text`, then optional `keys` (e.g. ['enter']), and returns the output that follows.",
    inputSchema: {
      session_id: sessionId,
      text: z.string().optional(),
      keys: z.array(z.enum(Object.keys(SPECIAL_KEYS) as [SpecialKey, ...SpecialKey[]])).optional().describe('Special keys sent after text, in order.'),
      wait_ms: waitMs,
      max_chars: maxChars,
    },
    annotations: { ...DESTRUCTIVE, openWorldHint: true },
  }, ({ session_id, text, keys, wait_ms, max_chars }) => run(async () => {
    const input = (text ?? '') + (keys ?? []).map(k => SPECIAL_KEYS[k]).join('')
    if (!input) throw new Error('Provide text and/or keys.')
    return ok(await useTerminal(api, session_id, { input, waitMs: wait_ms, maxChars: max_chars }) || '(no output yet)')
  }))
}

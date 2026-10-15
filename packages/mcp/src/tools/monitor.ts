import { z } from 'zod'
import type { TaskSquadApi } from '../api.js'
import { MONITOR_HTML } from '../widget/monitor-html.js'
import { READ, run, type Register } from './util.js'

// The UI resource URI is the client's cache key: bump the version on breaking HTML changes.
export const MONITOR_URI = 'ui://tasksquad/monitor-v2.html'
export const MCP_APP_MIME = 'text/html;profile=mcp-app'

const RECENT_LIMIT = 8

type Row = Record<string, unknown>

export interface MonitorTask {
  id: string
  subject: string
  status: string
  agent_id: string
  agent_name: string
  updated_at: number
  url: string
}

export interface MonitorSnapshot {
  projects: Array<{ id: string; name: string }>
  project: { id: string; name: string } | null
  agents: Array<{ id: string; name: string; status: string; paused: boolean; last_seen: number | null }>
  needs_input: MonitorTask[]
  running: MonitorTask[]
  queued: MonitorTask[]
  recent: MonitorTask[]
  portal_url: string
  generated_at: number
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

// buildSnapshot reads one project's agents and tasks and keeps only what the monitor shows:
// no message bodies, sender IDs, session IDs or settings.
export async function buildSnapshot(api: TaskSquadApi, portalBase: string, teamId?: string): Promise<MonitorSnapshot> {
  const { teams } = await api.listTeams()
  const projects = teams.map(t => ({ id: str(t.id), name: str(t.name) }))
  const empty: MonitorSnapshot = {
    projects, project: null, agents: [], needs_input: [], running: [], queued: [], recent: [],
    portal_url: `${portalBase}/dashboard`, generated_at: Date.now(),
  }
  const project = teamId ? projects.find(p => p.id === teamId) : projects[0]
  if (teamId && !project) throw new Error(`Project ${teamId} not found. Use list_projects for valid IDs.`)
  if (!project) return empty

  const [{ agents }, { tasks }] = await Promise.all([api.listAgents(project.id), api.listTasks(project.id)])
  const names = new Map(agents.map(a => [str(a.id), str(a.name)]))
  const toTask = (t: Row): MonitorTask => ({
    id: str(t.id),
    subject: str(t.subject) || '(no subject)',
    status: t.tui_blocked ? 'waiting_input' : str(t.status),
    agent_id: str(t.agent_id),
    agent_name: names.get(str(t.agent_id)) ?? 'Unknown agent',
    updated_at: Math.max(num(t.completed_at), num(t.started_at), num(t.created_at)),
    url: `${portalBase}/dashboard/tasks/${encodeURIComponent(str(t.id))}`,
  })
  const all = tasks.map(toTask).sort((a, b) => b.updated_at - a.updated_at)
  const inStatus = (...s: string[]) => all.filter(t => s.includes(t.status))
  return {
    ...empty,
    project,
    agents: agents.map(a => ({
      id: str(a.id), name: str(a.name), status: str(a.status) || 'offline',
      paused: !!a.paused, last_seen: typeof a.last_seen === 'number' ? a.last_seen : null,
    })),
    needs_input: inStatus('waiting_input'),
    running: inStatus('running', 'wrapping_up'),
    queued: inStatus('pending', 'scheduled'),
    recent: inStatus('done', 'failed', 'cancelled').slice(0, RECENT_LIMIT),
  }
}

// summary is the text the model reads; the widget renders structuredContent.
export function summary(s: MonitorSnapshot): string {
  if (!s.project) return 'The user has no TaskSquad projects yet.'
  const online = s.agents.filter(a => a.status !== 'offline').length
  const lines = [
    `Project "${s.project.name}": ${online}/${s.agents.length} agents online, ` +
    `${s.needs_input.length} task(s) need input, ${s.running.length} running, ${s.queued.length} queued.`,
  ]
  for (const t of s.needs_input) lines.push(`Needs input: "${t.subject}" (${t.agent_name}, task ${t.id})`)
  lines.push('The monitor is shown to the user; do not repeat its contents unless asked.')
  return lines.join('\n')
}

const task = z.object({
  id: z.string(), subject: z.string(), status: z.string(), agent_id: z.string(),
  agent_name: z.string(), updated_at: z.number(), url: z.string(),
})
const project = z.object({ id: z.string(), name: z.string() })
// outputSchema of both monitor tools; mirrors MonitorSnapshot.
const SNAPSHOT_SCHEMA = {
  projects: z.array(project),
  project: project.nullable(),
  agents: z.array(z.object({
    id: z.string(), name: z.string(), status: z.string(), paused: z.boolean(), last_seen: z.number().nullable(),
  })),
  needs_input: z.array(task),
  running: z.array(task),
  queued: z.array(task),
  recent: z.array(task),
  portal_url: z.string(),
  generated_at: z.number(),
}
const teamIdInput = { team_id: z.string().optional().describe('Project ID (from list_projects). Omit for the first project.') }

// Data tool (get_work_status) and render tool (open_monitor) share one snapshot. The monitor
// UI refreshes through the data tool, so a refresh doesn't re-render the widget.
export const registerMonitor: Register = (server, { api, env }) => {
  const snapshot = (teamId?: string) => run(async () => {
    const snap = await buildSnapshot(api, env.PORTAL_BASE, teamId)
    return { content: [{ type: 'text' as const, text: summary(snap) }], structuredContent: { ...snap } }
  })

  server.registerResource('tasksquad-monitor', MONITOR_URI, {
    title: 'TaskSquad monitor',
    description: 'Live view of a project\'s agents and tasks.',
    mimeType: MCP_APP_MIME,
  }, async () => ({
    contents: [{
      uri: MONITOR_URI,
      mimeType: MCP_APP_MIME,
      text: MONITOR_HTML,
      _meta: {
        // No network access or external assets: the widget only talks to the host bridge.
        ui: { prefersBorder: true, domain: env.PORTAL_BASE, csp: { connectDomains: [], resourceDomains: [] } },
        'openai/widgetDomain': env.PORTAL_BASE,
        'openai/widgetDescription': 'Live dashboard of the project\'s agents and the tasks that need input, are running, queued or recently finished.',
        'openai/widgetPrefersBorder': true,
        'openai/widgetCSP': { connect_domains: [], resource_domains: [] },
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
      },
    }],
  }))

  server.registerTool('get_work_status', {
    title: 'Get work status',
    description: 'Summarise what a TaskSquad project\'s agents are doing: which agents are online, and which tasks need input, are running, queued or recently finished (subject, agent, status, time, portal link). Use to answer status questions; use open_monitor to show it visually.',
    inputSchema: teamIdInput,
    outputSchema: SNAPSHOT_SCHEMA,
    annotations: READ,
    _meta: {
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': 'Checking on your agents…',
      'openai/toolInvocation/invoked': 'Checked on your agents',
    },
  }, ({ team_id }) => snapshot(team_id))

  server.registerTool('open_monitor', {
    title: 'Open work monitor',
    description: 'Show a live, auto-refreshing monitor of a TaskSquad project inside the chat: agents online and busy, and tasks that need input, are running, queued or recently finished. Use when the user wants to monitor, watch or see their agents\' work. Defaults to the first project.',
    inputSchema: teamIdInput,
    outputSchema: SNAPSHOT_SCHEMA,
    annotations: READ,
    _meta: {
      ui: { resourceUri: MONITOR_URI },
      'openai/outputTemplate': MONITOR_URI,
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': 'Opening the monitor…',
      'openai/toolInvocation/invoked': 'Monitor ready',
    },
  }, ({ team_id }) => snapshot(team_id))
}

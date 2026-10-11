import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { version } from '../package.json'
import { TaskSquadApi } from './api.js'
import type { Env, Props } from './env.js'
import { registerAgents } from './tools/agents.js'
import { registerBlocked } from './tools/blocked.js'
import { registerConveyors } from './tools/conveyors.js'
import { registerLibrary } from './tools/library.js'
import { registerMemory } from './tools/memory.js'
import { registerNotes } from './tools/notes.js'
import { registerPlanners } from './tools/planners.js'
import { registerPortals } from './tools/portals.js'
import { registerProjects } from './tools/projects.js'
import { registerTasks } from './tools/tasks.js'
import type { ToolContext } from './tools/util.js'

export const SERVER_INSTRUCTIONS = `TaskSquad is a coordination layer where humans and AI agents work through an email-style inbox.
Model: projects (API: teams) contain agents (daemons on users' machines running a CLI like Claude Code) and tasks (threads sent to one agent).
Typical flow: list_projects → list_agents → create_task → poll get_task until the agent replies (status waiting_input/done) → reply_to_task or close_task.
Daemons poll every ~60s, so new tasks are not picked up instantly. Times are epoch milliseconds in responses; tool inputs accept ISO-8601.
Destructive and membership/credential actions (delete_*, add/remove members, agent tokens) always fail: tell the user to do them in the TaskSquad portal.`

export function buildServer(env: Env, props: Props, fetchImpl?: typeof fetch): McpServer {
  const server = new McpServer({ name: 'tasksquad', version }, { instructions: SERVER_INSTRUCTIONS })
  const ctx: ToolContext = { api: new TaskSquadApi(env.API_BASE, props.apiToken, fetchImpl), env, props }
  for (const register of [
    registerProjects, registerAgents, registerTasks, registerConveyors, registerNotes,
    registerLibrary, registerMemory, registerPlanners, registerPortals, registerBlocked,
  ]) register(server, ctx)
  return server
}

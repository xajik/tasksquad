import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js'
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
import { AUTH_REQUIRED, type ToolContext } from './tools/util.js'

export const SERVER_INSTRUCTIONS = `TaskSquad is a coordination layer where humans and AI agents work through an email-style inbox.
Model: projects (API: teams) contain agents (daemons on users' machines running a CLI like Claude Code) and tasks (threads sent to one agent).
Typical flow: list_projects → list_agents → create_task → poll get_task until the agent replies (status waiting_input/done) → reply_to_task or close_task.
Daemons poll every ~60s, so new tasks are not picked up instantly. Times are epoch milliseconds in responses; tool inputs accept ISO-8601.
Destructive and membership/credential actions (delete_*, add/remove members, agent tokens) always fail: tell the user to do them in the TaskSquad portal.`

// Every tool needs the signed-in user (ChatGPT Apps SDK per-tool security schemes).
export const SECURITY_SCHEMES = [{ type: 'oauth2' }]

// origin is the public origin the client connected to; it names the resource metadata
// in auth challenges.
export function buildServer(env: Env, props: Props, fetchImpl?: typeof fetch, origin = env.PUBLIC_URL): McpServer {
  const server = new McpServer({ name: 'tasksquad', version }, { instructions: SERVER_INSTRUCTIONS })
  const ctx: ToolContext = { api: new TaskSquadApi(env.API_BASE, props.apiToken, fetchImpl), env, props }
  for (const register of [
    registerProjects, registerAgents, registerTasks, registerConveyors, registerNotes,
    registerLibrary, registerMemory, registerPlanners, registerPortals, registerBlocked,
  ]) register(server, ctx)
  addOpenAIAuth(server, `${origin}/.well-known/oauth-protected-resource/mcp`)
  return server
}

type Handler = (request: unknown, extra: unknown) => Promise<unknown>

// addOpenAIAuth adds what ChatGPT needs to show its sign-in UI and that McpServer can't
// express: securitySchemes on every listed tool, and an mcp/www_authenticate challenge
// on tool errors marked AUTH_REQUIRED. It wraps the SDK's own handlers, so the server
// test fails if an SDK upgrade moves them.
function addOpenAIAuth(server: McpServer, resourceMetadata: string) {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers
  const wrap = (method: string, fn: (result: unknown) => unknown) => {
    const inner = handlers.get(method)
    if (!inner) throw new Error(`MCP SDK has no ${method} handler to wrap`)
    handlers.set(method, async (request, extra) => fn(await inner(request, extra)))
  }
  wrap('tools/list', r => {
    const res = r as ListToolsResult
    return { ...res, tools: res.tools.map(t => ({ ...t, securitySchemes: SECURITY_SCHEMES })) }
  })
  const challenge = `Bearer resource_metadata="${resourceMetadata}", error="invalid_token", ` +
    'error_description="Your TaskSquad session expired. Sign in again to continue."'
  wrap('tools/call', r => {
    const res = r as CallToolResult
    if (!res._meta?.[AUTH_REQUIRED]) return res
    const { [AUTH_REQUIRED]: _, ...meta } = res._meta
    return { ...res, _meta: { ...meta, 'mcp/www_authenticate': [challenge] } }
  })
}

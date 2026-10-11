import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { errorResult, type Register } from './util.js'

// Sensitive actions are exposed so agents can discover them, but always refuse:
// the user must perform them in the TaskSquad portal themselves.
export const BLOCKED_TOOLS: Array<{ name: string; title: string; action: string; where: string; schema: z.ZodRawShape }> = [
  { name: 'delete_project', title: 'Delete project', action: 'Deleting a project', where: 'Project settings', schema: { team_id: z.string() } },
  { name: 'add_project_member', title: 'Add project member', action: 'Adding a member to a project', where: 'Project → Members', schema: { team_id: z.string(), email: z.string() } },
  { name: 'remove_project_member', title: 'Remove project member', action: 'Removing a project member', where: 'Project → Members', schema: { team_id: z.string(), user_id: z.string() } },
  { name: 'delete_agent', title: 'Delete agent', action: 'Deleting an agent', where: 'Agents', schema: { team_id: z.string(), agent_id: z.string() } },
  { name: 'create_agent_token', title: 'Create agent token', action: 'Creating a daemon token (a secret credential)', where: 'Agents → Connect', schema: { team_id: z.string(), agent_id: z.string() } },
  { name: 'delete_task', title: 'Delete task', action: 'Deleting a task', where: 'Inbox', schema: { task_id: z.string() } },
  { name: 'delete_conveyor', title: 'Delete conveyor', action: 'Deleting a conveyor', where: 'Conveyors', schema: { team_id: z.string(), conveyor_id: z.string() } },
  { name: 'delete_note', title: 'Delete note', action: 'Deleting a note', where: 'Notes', schema: { team_id: z.string(), note_id: z.string() } },
  { name: 'delete_note_comment', title: 'Delete note comment', action: 'Deleting a note comment', where: 'Notes', schema: { team_id: z.string(), note_id: z.string(), comment_id: z.string() } },
  { name: 'delete_library_item', title: 'Delete skill / sub-agent / command', action: 'Deleting a skill, sub-agent or command', where: 'Skills', schema: { team_id: z.string(), kind: z.string(), id: z.string() } },
  { name: 'delete_planner', title: 'Delete planner', action: 'Deleting a planner', where: 'Planners', schema: { team_id: z.string(), planner_id: z.string() } },
]

export function manualActionResult(portalBase: string, action: string, where: string): CallToolResult {
  return errorResult(
    `The user needs to take this action manually. ${action} is not available to agents through MCP. ` +
    `Ask the user to do it in the TaskSquad portal (${portalBase}, ${where}).`,
  )
}

export const registerBlocked: Register = (server, { env }) => {
  for (const t of BLOCKED_TOOLS) {
    server.registerTool(t.name, {
      title: `${t.title} (manual only)`,
      description: `${t.action} requires the user. This tool always fails with instructions for the user to do it manually in the TaskSquad portal.`,
      inputSchema: t.schema,
      // It never changes anything, so clients need not warn before calling it.
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async () => manualActionResult(env.PORTAL_BASE, t.action, t.where))
  }
}

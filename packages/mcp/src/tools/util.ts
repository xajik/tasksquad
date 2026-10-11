import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ApiError, type TaskSquadApi } from '../api.js'
import type { Env, Props } from '../env.js'

export interface ToolContext {
  api: TaskSquadApi
  env: Env
  props: Props
}

export type Register = (server: McpServer, ctx: ToolContext) => void

export function ok(data: unknown): CallToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text }] }
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

export function toolError(e: unknown): CallToolResult {
  if (e instanceof ApiError) {
    if (e.status === 401) {
      return errorResult('TaskSquad session expired or was revoked. Ask the user to reconnect (re-authenticate) the TaskSquad MCP server.')
    }
    if (e.status === 403 || e.status === 404) {
      return errorResult(`${e.message}. Check the IDs (use the list_* tools) and that the user can access this project.`)
    }
    return errorResult(e.message)
  }
  return errorResult(e instanceof Error ? e.message : String(e))
}

// run wraps a tool body: returns its value as JSON text, or an isError result.
export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const out = await fn()
    return isToolResult(out) ? out : ok(out)
  } catch (e) {
    return toolError(e)
  }
}

function isToolResult(v: unknown): v is CallToolResult {
  return !!v && typeof v === 'object' && Array.isArray((v as { content?: unknown }).content)
}

// toMillis accepts an ISO-8601 string or epoch milliseconds (the worker stores ms).
export function toMillis(v: string | number | undefined): number | undefined {
  if (v === undefined || v === '') return undefined
  if (typeof v === 'number') return v
  if (/^\d+$/.test(v)) return Number(v)
  const t = Date.parse(v)
  if (Number.isNaN(t)) throw new Error(`Invalid date/time: ${v}. Use ISO-8601, e.g. 2026-10-12T09:00:00Z.`)
  return t
}

export const READ = { readOnlyHint: true, openWorldHint: false } as const
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const

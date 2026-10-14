import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from './env.js'
import { buildServer } from './server.js'
import { BLOCKED_TOOLS } from './tools/blocked.js'

const env = { API_BASE: 'https://api.test', PORTAL_BASE: 'https://portal.test', PUBLIC_URL: 'https://mcp.test' } as Env

async function connect(fetchImpl: typeof fetch, sent: unknown[] = []) {
  const server = buildServer(env, { apiToken: 'tsq_cli_x', userId: 'u1', email: 'u@test' }, fetchImpl)
  const [a, b] = InMemoryTransport.createLinkedPair()
  // Record the raw messages the server sends: the client's schema strips fields MCP doesn't define.
  const send = a.send.bind(a)
  a.send = async (message, options) => { sent.push(structuredClone(message)); return send(message, options) }
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

function text(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0]!).text
}

describe('TaskSquad MCP server', () => {
  it('exposes the portal capabilities and the blocked actions', async () => {
    const client = await connect(vi.fn())
    const names = (await client.listTools()).tools.map(t => t.name)
    for (const n of ['whoami', 'list_projects', 'list_agents', 'create_task', 'get_task', 'reply_to_task', 'close_task',
      'list_conveyors', 'create_note', 'list_library', 'list_memory', 'create_planner', 'open_portal', 'read_live_terminal']) {
      expect(names).toContain(n)
    }
    for (const t of BLOCKED_TOOLS) expect(names).toContain(t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(BLOCKED_TOOLS.map(t => [t.name, t] as const))('%s refuses and asks for manual action', async (_name, tool) => {
    const fetchImpl = vi.fn()
    const client = await connect(fetchImpl)
    const args = Object.fromEntries(Object.keys(tool.schema).map(k => [k, 'x']))
    const result = await client.callTool({ name: tool.name, arguments: args })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('The user needs to take this action manually')
    expect(text(result)).toContain('https://portal.test')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('proxies list_projects to the worker with the grant token', async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => Response.json({ teams: [{ id: 't1', name: 'Core' }] }))
    const client = await connect(fetchImpl)
    const result = await client.callTool({ name: 'list_projects', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(text(result))).toEqual({ teams: [{ id: 't1', name: 'Core' }] })
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.test/teams')
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe('Bearer tsq_cli_x')
  })

  it('converts ISO scheduled_at to epoch ms when creating a task', async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => Response.json({ id: 'task1', status: 'scheduled' }))
    const client = await connect(fetchImpl)
    await client.callTool({ name: 'create_task', arguments: { team_id: 't1', agent_id: 'a1', subject: 'S', scheduled_at: '2026-10-12T09:00:00Z' } })
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).scheduled_at).toBe(Date.parse('2026-10-12T09:00:00Z'))
  })

  it('reports an expired TaskSquad token as a reconnect instruction with an auth challenge', async () => {
    const client = await connect(vi.fn(async () => Response.json({ error: 'token_expired' }, { status: 401 })))
    const result = await client.callTool({ name: 'whoami', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('reconnect')
    expect(result._meta).toEqual({ 'mcp/www_authenticate': [
      'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp", error="invalid_token", ' +
      'error_description="Your TaskSquad session expired. Sign in again to continue."',
    ] })
  })

  it('leaves other errors without an auth challenge', async () => {
    const client = await connect(vi.fn(async () => Response.json({ error: 'nope' }, { status: 403 })))
    const result = await client.callTool({ name: 'whoami', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result._meta).toBeUndefined()
  })

  it('declares OAuth securitySchemes on every tool and marks whoami as the profile tool', async () => {
    const sent: unknown[] = []
    const client = await connect(vi.fn(), sent)
    await client.listTools()
    const raw = sent.map(m => (m as { result?: { tools?: Array<Record<string, unknown>> } }).result?.tools).find(Boolean)!
    expect(raw.length).toBeGreaterThan(0)
    for (const t of raw) {
      expect(t.securitySchemes).toEqual([{ type: 'oauth2' }])
      expect((t._meta as Record<string, unknown>).securitySchemes).toEqual([{ type: 'oauth2' }])
    }
    expect((raw.find(t => t.name === 'whoami')!._meta as Record<string, unknown>)['openai/profile']).toBe(true)
  })

  it('returns objects and arrays as structuredContent too', async () => {
    const client = await connect(vi.fn(async () => Response.json({ teams: [{ id: 't1', name: 'Core' }] })))
    const result = await client.callTool({ name: 'list_projects', arguments: {} })
    expect(result.structuredContent).toEqual({ teams: [{ id: 't1', name: 'Core' }] })
  })

  it('get_task merges the task and its thread', async () => {
    const fetchImpl = vi.fn(async (u: RequestInfo | URL) => String(u).endsWith('/messages')
      ? Response.json({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] })
      : Response.json({ id: 'task1', status: 'done' }))
    const client = await connect(fetchImpl)
    const out = JSON.parse(text(await client.callTool({ name: 'get_task', arguments: { task_id: 'task1', last_messages: 2 } })))
    expect(out.task.status).toBe('done')
    expect(out.messages.map((m: { id: string }) => m.id)).toEqual(['m2', 'm3'])
    expect(out.message_count).toBe(3)
  })
})

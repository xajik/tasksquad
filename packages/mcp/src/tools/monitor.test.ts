import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../env.js'
import { buildServer } from '../server.js'
import { MCP_APP_MIME, MONITOR_URI, type MonitorSnapshot } from './monitor.js'

const env = { API_BASE: 'https://api.test', PORTAL_BASE: 'https://portal.test', PUBLIC_URL: 'https://mcp.test' } as Env

const api = vi.fn(async (u: RequestInfo | URL) => {
  const url = String(u)
  if (url.endsWith('/teams')) return Response.json({ teams: [{ id: 't1', name: 'Core' }, { id: 't2', name: 'Docs' }] })
  if (url.includes('/agents')) return Response.json({ agents: [
    { id: 'a1', name: 'Pi', status: 'idle', last_seen: 5, paused: false },
    { id: 'a2', name: 'Claude', status: 'offline', last_seen: 1, paused: false },
  ] })
  return Response.json({ tasks: [
    { id: 'k1', agent_id: 'a1', subject: 'Fix tests', status: 'waiting_input', created_at: 1, started_at: 2, sender_id: 'u1', session_id: 's1' },
    { id: 'k2', agent_id: 'a1', subject: 'Blocked on prompt', status: 'running', tui_blocked: true, created_at: 3 },
    { id: 'k3', agent_id: 'a2', subject: 'Write docs', status: 'running', created_at: 4 },
    { id: 'k4', agent_id: 'a2', subject: 'Later', status: 'scheduled', created_at: 5 },
    { id: 'k5', agent_id: 'a9', subject: 'Old', status: 'done', created_at: 1, completed_at: 9 },
  ] })
})

async function connect() {
  const server = buildServer(env, { apiToken: 'tsq_cli_x', userId: 'u1', email: 'u@test' }, api as unknown as typeof fetch)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

describe('open_monitor', () => {
  it('links the tool to the UI resource', async () => {
    const client = await connect()
    const tool = (await client.listTools()).tools.find(t => t.name === 'open_monitor')!
    expect(tool.annotations?.readOnlyHint).toBe(true)
    expect(tool._meta).toMatchObject({ ui: { resourceUri: MONITOR_URI }, 'openai/outputTemplate': MONITOR_URI })
    const res = await client.readResource({ uri: MONITOR_URI })
    expect(res.contents[0]!.mimeType).toBe(MCP_APP_MIME)
    expect(String((res.contents[0] as { text: string }).text)).toContain('ui/initialize')
  })

  it('groups tasks by what needs attention and drops private fields', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'open_monitor', arguments: { team_id: 't1' } })
    const snap = result.structuredContent as unknown as MonitorSnapshot
    expect(snap.project).toEqual({ id: 't1', name: 'Core' })
    expect(snap.projects).toHaveLength(2)
    expect(snap.needs_input.map(t => t.id).sort()).toEqual(['k1', 'k2'])
    expect(snap.running.map(t => t.id)).toEqual(['k3'])
    expect(snap.queued.map(t => t.id)).toEqual(['k4'])
    expect(snap.recent[0]).toMatchObject({ id: 'k5', agent_name: 'Unknown agent', url: 'https://portal.test/dashboard/tasks/k5' })
    expect(snap.needs_input.find(t => t.id === 'k1')).not.toHaveProperty('session_id')
    const text = (result.content as Array<{ text: string }>)[0]!.text
    expect(text).toContain('1/2 agents online')
    expect(text).toContain('2 task(s) need input')
  })

  it('rejects an unknown project', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'open_monitor', arguments: { team_id: 'nope' } })
    expect(result.isError).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { ApiError, TaskSquadApi } from './api.js'

function mockFetch(response: Response | (() => Response)) {
  return vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => typeof response === 'function' ? response() : response)
}

describe('TaskSquadApi', () => {
  it('sends the bearer token and JSON body to the worker path', async () => {
    const f = mockFetch(Response.json({ id: 't1', status: 'pending' }))
    const api = new TaskSquadApi('https://api.test', 'tsq_cli_abc', f)
    const out = await api.createTask({ team_id: 'team1', agent_id: 'a1', subject: 'Hi', scheduled_at: 123 })
    expect(out).toEqual({ id: 't1', status: 'pending' })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('https://api.test/tasks')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tsq_cli_abc')
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ team_id: 'team1', agent_id: 'a1', subject: 'Hi', scheduled_at: 123 })
  })

  it('uses multipart without a JSON content type when images are attached', async () => {
    const f = mockFetch(Response.json({ id: 't1' }))
    const api = new TaskSquadApi('https://api.test', 'tok', f)
    await api.createTask({ team_id: 'team1', agent_id: 'a1', subject: 'S', close_steps: ['/x'] }, [
      { filename: 'a.png', mime_type: 'image/png', data: new Uint8Array([1, 2, 3]) },
    ])
    const init = f.mock.calls[0]![1]!
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    const form = init.body as FormData
    expect(form.get('close_steps')).toBe('["/x"]')
    expect((form.get('images') as File).name).toBe('a.png')
  })

  it('encodes path segments and query filters', async () => {
    const f = mockFetch(() => Response.json({ tasks: [] }))
    const api = new TaskSquadApi('https://api.test', 'tok', f)
    await api.listTasks('team/1', { agentId: 'a 1', status: 'done' })
    expect(f.mock.calls[0]![0]).toBe('https://api.test/tasks?team_id=team%2F1&agent_id=a+1&status=done')
    await api.getNote('t', '../x')
    expect(f.mock.calls[1]![0]).toBe('https://api.test/teams/t/notes/..%2Fx')
  })

  it('throws ApiError with the worker error code', async () => {
    const api = new TaskSquadApi('https://api.test', 'tok', mockFetch(Response.json({ error: 'not_found' }, { status: 404 })))
    const e = await api.getTask('x').catch(err => err)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.status).toBe(404)
    expect(e.message).toContain('not_found')
  })

  it('tolerates empty and text responses', async () => {
    const api = new TaskSquadApi('https://api.test', 'tok', mockFetch(() => new Response(null, { status: 204 })))
    expect(await api.deleteMessage('t', 'm')).toEqual({})
    const text = new TaskSquadApi('https://api.test', 'tok', mockFetch(() => new Response('hello transcript')))
    expect(await text.transcript('t', 'm')).toBe('hello transcript')
  })
})

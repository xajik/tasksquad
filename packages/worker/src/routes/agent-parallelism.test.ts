import { afterAll, beforeAll, expect, it } from 'vitest'
import { db, fixture, setupGraphHarness, teardownGraphHarness } from '../graph/test-harness.js'
import { sql } from '../graph/store.js'
import { updateAgent } from './agents.js'
import { parallelHeartbeat, sessionOpen } from './daemon.js'
import type { Env } from '../types.js'

beforeAll(setupGraphHarness, 30_000)
afterAll(teardownGraphHarness)

it('enforces limits at open, drains on reduction, and routes replies to the owning task', async () => {
  const { agent, team, user } = await fixture()
  const env = { DB: db } as Env
  const ids = Array.from({ length: 12 }, () => crypto.randomUUID())
  await db.batch(ids.map((id, i) => sql(db,
    "INSERT INTO tasks(id,team_id,agent_id,sender_id,subject,status,created_at) VALUES(?,?,?,?,?,'pending',?)",
    id,team,agent,user,'parallel fixture',i)))
  const settings = () => sql(db,'SELECT * FROM agents WHERE id=?',agent).first<{ last_seen: number | null; reset_pending: number; paused: number; max_parallel_tasks: number }>()
  const poll = async (active: Array<{ task_id: string; status: string }> = []) =>
    await parallelHeartbeat(env, { id: agent, status: 'idle', daemon_device: 'fixture', active_tasks: active },
      team,(await settings())!,Date.now(),60_000) as { offers: unknown[]; task_updates: Array<{task_id: string; reply: string}> }
  const limit = (n: number) => updateAgent(new Request(`https://fixture/teams/${team}/agents/${agent}`, {
    method: 'PATCH',body: JSON.stringify({max_parallel_tasks:n}) }),env,{}, {userId:user} as never)
  const open = (id: string) => sessionOpen(new Request('https://fixture/daemon/session/open',{
    method:'POST',body:JSON.stringify({task_id:id,daemon_device:'fixture'})
  }),env,{}, { agentId:agent,teamId:team,userId:user,tokenId:'fixture' })
  expect((await poll()).offers).toHaveLength(1)
  expect((await limit(-1)).status).toBe(400)
  expect((await limit(2)).status).toBe(200)
  expect((await poll()).offers).toHaveLength(2)
  expect((await Promise.all([open(ids[0]),open(ids[0])])).map(r=>r.status).sort()).toEqual([201,409])
  expect((await open(ids[1])).status).toBe(201)
  expect((await open(ids[2])).status).toBe(409)
  const active = ids.slice(0,2).map(task_id => ({task_id,status:'running'}))
  await limit(1)
  expect((await poll(active)).offers).toHaveLength(0)
  await sql(db,"INSERT INTO messages(id,task_id,role,body,created_at) VALUES(?,?,'user','second task only',?)",
    crypto.randomUUID(),ids[1],Date.now()).run()
  active[1].status='waiting_input'
  expect((await poll(active)).task_updates).toMatchObject([{task_id:ids[1],reply:'second task only'}])
  await limit(0)
  expect((await poll(active)).offers).toHaveLength(8)
  for (const id of ids.slice(2)) expect((await open(id)).status).toBe(201)
  const otherDevice = await parallelHeartbeat(env,{ id: agent, status:'idle',daemon_device:'other',active_tasks:[] },
    team,(await settings())!,Date.now(),60_000)
  expect(otherDevice).toMatchObject({ offers: [] })
  expect((await sql(db,'SELECT count(*) AS n FROM sessions WHERE agent_id=? AND closed_at IS NULL',agent).first())?.n).toBe(12)
})

import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { Miniflare } from 'miniflare'
import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { create,graph,configuration,sql,rows,snapshot,type Assignment,type Result } from './store.js'
import { run,tick,intake,bindStatement,processResults } from './engine.js'
import type { GraphEnv } from './engine.js'

let mf:Miniflare,db:D1Database
const env=()=>({DB:db,ACTION_GRAPH_ENABLED:'true',POLL_CACHE:{put:async()=>undefined}} as GraphEnv)
async function fixture(review=true){
 const team=crypto.randomUUID(),user=crypto.randomUUID(),agent=crypto.randomUUID()
 await db.batch([
  sql(db,'INSERT INTO users(id,firebase_uid,email,created_at) VALUES(?,?,?,0)',user,user,user+'@test.com'),
  sql(db,'INSERT INTO teams(id,name,owner_id,created_at) VALUES(?,?,?,0)',team,'Project',user),
  sql(db,"INSERT INTO team_members(team_id,user_id,role,joined_at) VALUES(?,?,'owner',0)",team,user),
  sql(db,"INSERT INTO agents(id,team_id,name,status,created_at) VALUES(?,?,?,'idle',0)",agent,team,agent),
 ])
 const g=await create(db,team,user,{title:'Goal',description:'',body:'Private target',start_state:'Baseline',rule:{op:'AND',predicates:['verified'],scope:'test'},policy:{agents:[agent],grader:agent,decomposer:agent,review}})
 return {g,user,agent,team}
}
async function deliver(graphId:string,agent:string,raw:string){
 const attempt=await sql(db,`SELECT t.* FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? ORDER BY t.created_at DESC LIMIT 1`,graphId).first<{id:string;task_id:string}>()
 expect(attempt).toBeTruthy()
 const session=crypto.randomUUID()
 const bind=await bindStatement(db,attempt!.task_id,agent,session)
 await db.batch([sql(db,"INSERT INTO sessions(id,task_id,agent_id,status,started_at) VALUES(?,?,?,'running',0)",session,attempt!.task_id,agent),...bind])
 await intake(env(),session,agent,raw)
 return {session,attempt:attempt!}
}

beforeAll(async()=>{
 mf=new Miniflare({modules:true,script:'export default { fetch() { return new Response("test") } }',d1Databases:['DB'],compatibilityDate:'2026-01-01'})
 db=await mf.getD1Database('DB')
 for(const filename of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort()){
  const statements=JSON.parse(execFileSync('python3',['-c',`
import sqlite3,json,sys
source=open(sys.argv[1]).read(); pending=''; statements=[]
for char in source:
 pending+=char
 if char==';' and sqlite3.complete_statement(pending):
  statements.append(pending); pending=''
print(json.dumps(statements))
`, `migrations/${filename}`],{encoding:'utf8'})) as string[]
  for(const statement of statements)await db.prepare(statement).run()
 }
},30000)
afterAll(async()=>{await mf?.dispose()})

describe('durable inbox graph workflow',()=>{
 it('creates and decomposes, requiring exact approval and deduplicating delivery',async()=>{
  const {g,user,agent}=await fixture()
  await run(db,g.id,'run');await tick(env(),g.id)
  const {session}=await deliver(g.id,agent,JSON.stringify({subgoals:[{title:'Local task',description:'',body:'Measure the baseline',necessity_confidence:.8}]}))
  await intake(env(),session,agent,'duplicate must not overwrite')
  await processResults(db,await graph(db,g.id))
  const result=(await rows<Result>(db,`SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=?`,g.id))[0]
  expect(result.status).toBe('review')
  expect((await snapshot(db,await graph(db,g.id))).nodes).toHaveLength(2)
  const c=await configuration(db,await graph(db,g.id))
  await expect(run(db,g.id,'review',{result_id:result.id,output_hash:'wrong',config_version:c.version,verdict:'accept',user_id:user})).rejects.toThrow('conflict')
  await run(db,g.id,'review',{result_id:result.id,output_hash:result.output_hash,config_version:c.version,verdict:'accept',user_id:user})
  await run(db,g.id,'review',{result_id:result.id,output_hash:result.output_hash,config_version:c.version,verdict:'accept',user_id:user})
  expect((await snapshot(db,await graph(db,g.id))).nodes).toHaveLength(3)
  expect(await rows(db,'SELECT * FROM graph_approvals WHERE result_id=?',result.id)).toHaveLength(1)
  expect(await rows(db,"SELECT * FROM graph_assignments WHERE graph_id=? AND role='plan'",g.id)).toHaveLength(1)
 })
 it('persists one read-only formatting repair without repeating execution',async()=>{
  const {g,agent}=await fixture(false)
  await run(db,g.id,'run');await tick(env(),g.id)
  await deliver(g.id,agent,'not json')
  await processResults(db,await graph(db,g.id))
  const assignments=await rows<Assignment>(db,'SELECT * FROM graph_assignments WHERE graph_id=?',g.id)
  expect(assignments.filter(a=>a.role==='repair')).toHaveLength(1)
  expect(assignments.filter(a=>a.role==='execute')).toHaveLength(0)
 })
 it('rejects a wrong agent and repeat session open',async()=>{
  const {g,agent}=await fixture()
  await run(db,g.id,'run');await tick(env(),g.id)
  const task=(await rows<{task_id:string}>(db,'SELECT task_id FROM graph_attempts WHERE agent_id=?',agent))[0]
  await expect(bindStatement(db,task.task_id,'wrong',crypto.randomUUID())).rejects.toThrow('Unexpected')
  await deliver(g.id,agent,'{}')
  await expect(bindStatement(db,task.task_id,agent,crypto.randomUUID())).rejects.toThrow('Unexpected')
 })
 it('does not advance the graph on stale delivery',async()=>{
  const {g,agent}=await fixture(false)
  await run(db,g.id,'run');await tick(env(),g.id)
  await sql(db,'UPDATE graph_attempts SET deadline=0 WHERE agent_id=?',agent).run()
  await deliver(g.id,agent,'{"subgoals":[]}')
  await processResults(db,await graph(db,g.id))
  const result=await sql(db,`SELECT r.status FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.agent_id=?`,agent).first<{status:string}>()
  expect(result?.status).toBe('stale')
 })
})

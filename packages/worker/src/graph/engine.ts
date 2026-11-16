import type { Env } from '../types.js'
import { bumpInboxVersion } from '../inbox_version.js'
import { parseResult, hash, templates, type Role, type Policy } from './contracts.js'
import { assignment, commit, configuration, graph, id, json, nodeStatements, rows, sql, type Assignment, type Attempt, type Data, type Graph, type Result } from './store.js'

export type GraphEnv = Pick<Env, 'DB' | 'POLL_CACHE'> & { ACTION_GRAPH_ENABLED?: string }

const actionable = (role: Role) => role === 'execute' || role === 'undo'

export async function run(db: D1Database, graphId: string, command: string, body: Data = {}): Promise<void> {
 if (command==='resource') { const {resource}=await import('./store.js'); await resource(db,graphId,body); return }
 const g = await graph(db,graphId), c = await configuration(db,g)
 if (command === 'review') {
  const r = await sql(db,`SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE r.id=? AND a.graph_id=?`,body.result_id,g.id).first<Result>()
  if (!r) throw new Error('Result not found')
  if (r.output_hash !== body.output_hash || c.version !== body.config_version) throw new Error('Review version conflict')
  if (r.status==='accepted' || r.status==='rejected') return
  if (r.status!=='review' || !['accept','reject'].includes(body.verdict as string)) throw new Error('Result is not reviewable')
  const approval = sql(db,'INSERT INTO graph_approvals(result_id,output_hash,config_version,user_id,verdict,created_at) VALUES(?,?,?,?,?,?)',r.id,r.output_hash,c.version,body.user_id,body.verdict,Date.now())
  if (body.verdict==='reject') await commit(db,g,'rejected',r.id,{},[approval,sql(db,"UPDATE graph_results SET status='rejected' WHERE id=?",r.id),sql(db,"UPDATE graph_assignments SET status='rejected' WHERE id=(SELECT assignment_id FROM graph_attempts WHERE id=?)",r.attempt_id)])
  else await accept(db,g,r,[approval])
  return
 }
 if (command === 'configure') {
  if (g.status==='running') throw new Error('Pause before changing configuration')
  const active = await sql(db,"SELECT id FROM graph_assignments WHERE graph_id=? AND status IN ('running','pending','review','blocked','reconciling') LIMIT 1",g.id).first()
  if (active) throw new Error('Resolve existing assignments before changing configuration')
  const { policy: normalize } = await import('./contracts.js')
  const p = normalize(body.policy as Partial<Policy>)
  for (const a of [...p.agents,p.grader,p.decomposer,...(p.fallback?[p.fallback]:[])]) if (!await sql(db,'SELECT id FROM agents WHERE id=? AND team_id=?',a,g.team_id).first()) throw new Error('Agent outside project')
  await commit(db,g,'configured',null,{},[sql(db,'INSERT INTO graph_configs(graph_id,version,policy,success_rule,created_at) VALUES(?,?,?,?,?)',g.id,c.version+1,json(p),json(c.rule),Date.now())])
  return
 }
 if (command==='input') {
  const a = await sql(db,"SELECT * FROM graph_assignments WHERE id=? AND graph_id=? AND status IN ('blocked','error')",body.assignment_id,g.id).first<Assignment>()
  if (!a || typeof body.message!=='string' || body.message.length>3999) throw new Error('A blocked assignment and bounded input are required')
  const next = await assignment(db,g,'continue',{ assignment:a.id, previous:JSON.parse(a.input), user_input:body.message },{parent:a.id,node:a.node_id,edge:a.edge_id})
  await commit(db,g,'input',a.id,{},[...next.statements,sql(db,"UPDATE graph_assignments SET status='continuation' WHERE id=?",a.id)])
  return
 }
 if (!['run','pause','stop'].includes(command)) throw new Error('Unknown command')
 const status = command==='run'?'running':command==='pause'?'paused':'stopped'
 const ops: D1PreparedStatement[] = [sql(db,'UPDATE graphs SET status=? WHERE id=?',status,g.id)]
 if (command==='run') {
  const previous = await sql(db,'SELECT id FROM graph_assignments WHERE graph_id=? LIMIT 1',g.id).first()
  if (!previous) {
   const next = await assignment(db,g,'decompose',{goal:g.body,title:g.title,success_rule:c.rule})
   ops.push(...next.statements)
  }
 }
 if (command==='stop') {
  ops.push(sql(db,"UPDATE graph_assignments SET status='cancelled' WHERE graph_id=? AND status='pending' AND role NOT IN ('undo','reconcile','grade','project')",g.id))
  // Active processes retain reservations until reconciliation. Their normal result cannot authorize more work.
  ops.push(sql(db,"UPDATE graph_attempts SET deadline=? WHERE status='running' AND assignment_id IN (SELECT id FROM graph_assignments WHERE graph_id=? AND role='execute')",Date.now(),g.id))
 }
 await commit(db,g,command,null,{},ops)
}

export async function bindAttempt(db: D1Database, taskId: string, agentId: string, sessionId: string): Promise<boolean> {
 const attempt = await sql(db,'SELECT * FROM graph_attempts WHERE task_id=?',taskId).first<Attempt>()
 if (!attempt) return false
 if (attempt.agent_id!==agentId || attempt.status!=='pending' || attempt.session_id) throw new Error('Unexpected graph run')
 const res = await sql(db,"UPDATE graph_attempts SET session_id=?,status='running' WHERE id=? AND status='pending' AND session_id IS NULL",sessionId,attempt.id).run()
 if (!res.meta.changes) throw new Error('Graph run already bound')
 return true
}

/** Must be included in session-open's DB batch, so session FK and attempt bind are atomic. */
export async function bindStatement(db: D1Database, taskId: string, agentId: string, sessionId: string): Promise<D1PreparedStatement[]> {
 const t = await sql(db,'SELECT * FROM graph_attempts WHERE task_id=?',taskId).first<Attempt>()
 if (!t) return []
 if (t.agent_id!==agentId || t.status!=='pending' || t.session_id) throw new Error('Unexpected graph run')
 return [sql(db,"INSERT INTO graph_run_claims(task_id,session_id) VALUES(?,?)",taskId,sessionId),sql(db,"UPDATE graph_attempts SET session_id=?,status='running' WHERE id=? AND session_id IS NULL AND status='pending'",sessionId,t.id)]
}

export async function intake(env: GraphEnv, sessionId: string, agentId: string, raw: string): Promise<string | null> {
 if (env.ACTION_GRAPH_ENABLED!=='true') return null
 const t = await sql(env.DB,'SELECT * FROM graph_attempts WHERE session_id=? AND agent_id=?',sessionId,agentId).first<Attempt>()
 if (!t) return null
 const a = await sql(env.DB,'SELECT * FROM graph_assignments WHERE id=?',t.assignment_id).first<Assignment>()
 if (!a) return null
 const existing = await sql(env.DB,'SELECT id FROM graph_results WHERE attempt_id=?',t.id).first<{id:string}>()
 if (existing) return a.graph_id
 const resultId=id()
 const now=Date.now(), stale=t.status!=='running' || t.epoch!==a.attempt_count || now>t.deadline
 // Size bounded before hashing/persistence. Oversize responses retain a diagnostic prefix.
 const bounded = new TextEncoder().encode(raw).length>128*1024 ? raw.slice(0,60_000)+'\n[response exceeds limit]' : raw
 await env.DB.batch([
  sql(env.DB,'INSERT OR IGNORE INTO graph_results(id,attempt_id,raw,output_hash,status,created_at) VALUES(?,?,?,?,?,?)',resultId,t.id,bounded,await hash(bounded),stale?'stale':'received',now),
  ...(a.role==='execute'&&!stale?[sql(env.DB,`INSERT OR IGNORE INTO graph_grading(graph_id,execution_result_id,created_at) SELECT ?,id,? FROM graph_results WHERE attempt_id=?`,a.graph_id,now,t.id)]:[]),
  sql(env.DB,"UPDATE graph_attempts SET status=CASE WHEN status='running' THEN 'completed' ELSE status END,completed_at=COALESCE(completed_at,?) WHERE id=?",now,t.id),
 ])
 return a.graph_id
}

async function resolve(db: D1Database, r: Result): Promise<{ a: Assignment; original: Assignment; t: Attempt }> {
 const t = (await sql(db,'SELECT * FROM graph_attempts WHERE id=?',r.attempt_id).first<Attempt>())!
 const a = (await sql(db,'SELECT * FROM graph_assignments WHERE id=?',t.assignment_id).first<Assignment>())!
 const original = a.role==='repair' ? (await sql(db,'SELECT * FROM graph_assignments WHERE id=?',a.parent_id).first<Assignment>())! : a
 return {a,original,t}
}

export async function processResults(db: D1Database,g: Graph): Promise<void> {
 const pending = await rows<Result>(db,`SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? AND r.status='received' ORDER BY r.created_at,r.id`,g.id)
 for (const r of pending) {
  const {a,original,t}=await resolve(db,r), c=await configuration(db,g)
  if (a.config_version!==c.version) { await commit(db,g,'stale',r.id,{},[sql(db,"UPDATE graph_results SET status='stale' WHERE id=?",r.id)]); continue }
  try {
   r.parsed=json(parseResult(original.role as keyof typeof templates,r.raw))
  } catch(e) {
   const ops=[sql(db,"UPDATE graph_results SET status='invalid',validation_error=? WHERE id=?",String(e),r.id),sql(db,"DELETE FROM graph_reservations WHERE attempt_id=?",t.id),sql(db,"UPDATE graph_assignments SET status='error' WHERE id=?",a.id)]
   if (a.role!=='repair') {
    const fix=await assignment(db,g,'repair',{raw:r.raw,original_role:a.role,original_assignment:a.id,validation_error:String(e)},{parent:a.id,node:a.node_id,edge:a.edge_id,originalRole:a.role as keyof typeof templates})
    ops.push(...fix.statements)
   }
   await commit(db,g,'parse_error',r.id,{error:String(e)},ops)
   continue
  }
  await commit(db,g,'validated',r.id,{},[
   sql(db,"UPDATE graph_results SET parsed=?,status='review' WHERE id=?",r.parsed,r.id),
   sql(db,"UPDATE graph_assignments SET status='review' WHERE id=?",a.id),
   sql(db,'DELETE FROM graph_reservations WHERE attempt_id=?',t.id),
  ])
  r.status='review'
  if (!c.policy.review) { try { await accept(db,g,r) } catch(e) { await commit(db,g,'acceptance_blocked',r.id,{error:String(e)},[sql(db,'UPDATE graph_results SET validation_error=? WHERE id=?',String(e),r.id)]) } }
 }
}

async function evidenceStatements(db: D1Database,g:Graph,r:Result,node:string,items:Data[]): Promise<D1PreparedStatement[]> {
 const c=await configuration(db,g), now=Date.now(), ops: D1PreparedStatement[]=[]
 for (const e of items) {
  if (typeof e.id!=='string' || !e.resource_id || !(await sql(db,'SELECT id FROM graph_resources WHERE id=? AND graph_id=?',e.resource_id,g.id).first())) throw new Error('Evidence requires a supplied graph resource')
  if (Number(e.observed_at)>now+60_000 || Number(e.expires_at)<=Number(e.observed_at) || Number(e.expires_at)>Number(e.observed_at)+c.policy.freshness_ms) throw new Error('Evidence freshness invalid')
  const previous=await sql(db,'SELECT id FROM graph_evidence WHERE id=?',e.id).first()
  if (previous) throw new Error('Evidence IDs cannot be reused')
  ops.push(sql(db,'INSERT INTO graph_evidence(id,graph_id,node_id,source_result_id,predicate,value,scope,observed_at,expires_at,resource_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',e.id,g.id,node,r.id,e.predicate,e.value,e.scope,e.observed_at,e.expires_at,e.resource_id,now))
 }
 return ops
}

export async function accept(db: D1Database,g:Graph,r:Result,extra:D1PreparedStatement[]=[]): Promise<void> {
 const {a,original}=await resolve(db,r), c=await configuration(db,g)
 if (r.status==='accepted') return
 if (r.status!=='review' || original.config_version!==c.version || !r.parsed) throw new Error('Result no longer eligible')
 const d=JSON.parse(r.parsed) as Data, input=JSON.parse(original.input) as Data
 const ops: D1PreparedStatement[]=[...extra,
  sql(db,"UPDATE graph_results SET status='accepted',accepted_at=? WHERE id=?",Date.now(),r.id),
  sql(db,"UPDATE graph_assignments SET status='accepted' WHERE id IN (?,?)",a.id,original.id),
 ]
 const enqueue=async(role:Role,data:unknown,links:{node?:string|null;edge?:string|null;parent?:string|null;priority?:number}={})=>{
  const next=await assignment(db,g,role,data,{parent:original.id,...links});ops.push(...next.statements);return next.id
 }
 switch(original.role) {
  case 'decompose':
   for(const sub of d.subgoals as Data[]) if (Number(sub.necessity_confidence)>=c.policy.threshold) {
    const n=nodeStatements(db,g,'milestone',sub,r.id);ops.push(...n.statements)
    if(g.status==='running') await enqueue('plan',{task:sub,observed_start:g.start_state,observations:await executionNodes(db,g.id),resources:await executionResources(db,g.id)},{node:n.id})
   }
   break
  case 'plan':
   for(const action of d.actions as Data[]) {
    if(!await sql(db,"SELECT id FROM graph_nodes WHERE id=? AND graph_id=? AND kind!='goal'",action.from_id,g.id).first()) throw new Error('Action source outside permitted graph')
    if(!(action.steps as unknown[]).length || !(action.undo_steps as unknown[]).length || !(action.restoration_predicates as unknown[]).length || !action.baseline) throw new Error('Action needs a complete restoration contract')
    const proposalId=id()
    ops.push(sql(db,'INSERT INTO graph_proposals(id,graph_id,source_result_id,content,created_at) VALUES(?,?,?,?,?)',proposalId,g.id,r.id,json(action),Date.now()))
    await enqueue('merge',{proposal_id:proposalId,action,existing_states:await executionNodes(db,g.id)},{node:original.node_id})
   }
   break
  case 'merge': {
   const p=await sql(db,'SELECT * FROM graph_proposals WHERE id=? AND graph_id=?',input.proposal_id,g.id).first<{id:string;content:string;status:string}>()
   if(!p || p.status!=='pending') throw new Error('Proposal no longer pending')
   if(d.decision==='uncertain'||d.decision==='reject') {ops.push(sql(db,'UPDATE graph_proposals SET status=? WHERE id=?',d.decision==='reject'?'rejected':'uncertain',p.id));break}
   const action=JSON.parse(p.content) as Data
   let target:string
   if(d.decision==='equivalent') {
    const match=await sql(db,"SELECT * FROM graph_nodes WHERE id=? AND graph_id=? AND kind!='goal'",d.equivalent_node_id,g.id).first<{id:string;body:string}>()
    // Reviewer must name an existing state; action identity is still retained separately.
    if(!match) throw new Error('Equivalent state outside graph')
    const equivalent=await sql(db,`SELECT p.* FROM graph_plans p JOIN graph_edges e ON e.id=p.edge_id WHERE e.to_id=? AND e.from_id=? AND e.graph_id=? AND p.baseline=? AND p.resource_versions=? AND p.effects=? AND p.steps=? LIMIT 1`,match.id,action.from_id,g.id,action.baseline,json(action.resource_versions),json(action.effects),json(action.steps)).first()
    if(!equivalent) throw new Error('Structured equivalence not established')
    target=match.id
   }else {const n=nodeStatements(db,g,'outcome',action,r.id);target=n.id;ops.push(...n.statements)}
   const edge=id()
   ops.push(sql(db,'INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',edge,g.id,action.from_id,target,action.title,action.description,action.body,r.id,Date.now()),
    sql(db,'INSERT INTO graph_plans(edge_id,baseline,predicates,steps,undo_steps,cost,recovery_cost,resource_versions,effects) VALUES(?,?,?,?,?,?,?,?,?)',edge,action.baseline,json(action.restoration_predicates),json(action.steps),json(action.undo_steps),action.cost,action.recovery_cost,json(action.resource_versions),json(action.effects)),
    sql(db,"UPDATE graph_proposals SET status='published' WHERE id=?",p.id))
   if(g.status==='running') await enqueue('execute',{plan:action,target_node:target},{node:target,edge})
   break
  }
  case 'execute': {
   const n=nodeStatements(db,g,'outcome',d,r.id,original.node_id);ops.push(...n.statements,...await evidenceStatements(db,g,r,n.id,d.evidence as Data[]))
   if(a.role==='repair') ops.push(sql(db,`UPDATE graph_grading SET execution_result_id=? WHERE execution_result_id IN (SELECT r.id FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id WHERE t.assignment_id=?)`,r.id,original.id))
   if(d.outcome==='blocked') ops.push(sql(db,"UPDATE graph_assignments SET status='blocked' WHERE id=?",original.id))
   if(d.outcome==='failed') {
    ops.push(sql(db,"UPDATE graph_assignments SET status='restoring' WHERE id=?",original.id))
    await enqueue('undo',{plan:input.plan,failed_outcome:d,resources:await executionResources(db,g.id)},{node:n.id,edge:original.edge_id})
   }
   break
  }
  case 'grade':
  case 'project': {
   const ids=d.evidence_ids as string[]
   const allowed=(input.evidence as Data[]).map(e=>e.id)
   if(ids.some(e=>!allowed.includes(e))) throw new Error('Grade references unsupplied evidence')
   for(const evidence of ids) ops.push(sql(db,'INSERT INTO graph_evaluations(graph_id,edge_id,source_result_id,evidence_id,context,local_score,goal_score,created_at) VALUES(?,?,?,?,?,?,?,?)',g.id,original.edge_id,r.id,evidence,`${input.execution_result_id}:${original.role}`,original.role==='grade'?d.local_score:null,original.role==='project'?d.goal_score:null,Date.now()))
   ops.push(sql(db,'UPDATE graph_grading SET stage=?,assignment_id=NULL,status=? WHERE execution_result_id=?',original.role==='grade'?'project':'done',original.role==='grade'?'pending':'done',input.execution_result_id))
   break
  }
  case 'undo': {
   const n=nodeStatements(db,g,'restoration',d,r.id,original.node_id);ops.push(...n.statements,...await evidenceStatements(db,g,r,n.id,d.evidence as Data[]))
   const predicates=((input.plan as Data).restoration_predicates??[]) as string[]
   const observed=d.evidence as Data[]
   const verified=d.restored===true && predicates.length>0 && predicates.every(p=>observed.some(e=>e.predicate===p && e.value==='true'))
   ops.push(sql(db,"UPDATE graph_assignments SET status=? WHERE id=?",verified?'restored':'blocked',original.parent_id))
   if(!verified) ops.push(sql(db,"UPDATE graph_assignments SET status='blocked' WHERE id=?",original.id))
   if(verified) {
    const parent=await sql(db,'SELECT * FROM graph_assignments WHERE id=?',original.parent_id).first<Assignment>()
    if(parent && parent.attempt_count<parent.max_attempts && g.status==='running') ops.push(sql(db,"UPDATE graph_assignments SET status='pending',available_at=? WHERE id=?",Date.now()+retryDelay(parent.attempt_count),parent.id))
   }
   break
  }
  case 'continue': {
   const parent=await sql(db,'SELECT * FROM graph_assignments WHERE id=?',original.parent_id).first<Assignment>()
   if(!parent) throw new Error('Missing blocked assignment')
   if(d.decision==='blocked') ops.push(sql(db,"UPDATE graph_assignments SET status='blocked' WHERE id=?",parent.id))
   else {
    // A fresh attempt is explicit; context records checkpoint semantics for the executor.
    const context={...JSON.parse(parent.input),continuation:d,user_input:input.user_input}
    ops.push(sql(db,"UPDATE graph_assignments SET input=?,status='pending',max_attempts=MAX(max_attempts,attempt_count+1),available_at=? WHERE id=?",json(context),Date.now(),parent.id))
   }
   break
  }
  case 'reconcile': {
   const prior=await sql(db,'SELECT * FROM graph_assignments WHERE id=?',original.parent_id).first<Assignment>()
   if(!prior) throw new Error('Missing interrupted assignment')
   if(d.decision==='unknown') {ops.push(sql(db,"UPDATE graph_assignments SET status='blocked' WHERE id=?",original.id));break}
   ops.push(sql(db,'DELETE FROM graph_reservations WHERE attempt_id IN (SELECT id FROM graph_attempts WHERE assignment_id=?)',prior.id))
   if(d.decision==='terminated_needs_undo') await enqueue('undo',{plan:JSON.parse(prior.input).plan,resources:await executionResources(db,g.id)},{parent:prior.id,node:prior.node_id,edge:prior.edge_id})
   else ops.push(sql(db,"UPDATE graph_assignments SET status=?,available_at=? WHERE id=?",prior.attempt_count<prior.max_attempts&&g.status==='running'?'pending':'error',Date.now()+retryDelay(prior.attempt_count),prior.id))
   break
  }
 }
 await commit(db,g,'accepted',r.id,{role:original.role},ops)
}

export function retryDelay(attempt:number,random=Math.random()):number {return Math.min(30_000*2**Math.max(0,attempt-1),480_000)*(0.8+random*.4)}
async function executionResources(db:D1Database,graphId:string):Promise<Data[]> {return rows(db,"SELECT id,version,title,description,body FROM graph_resources WHERE graph_id=? AND visibility='execution'",graphId)}
async function executionNodes(db:D1Database,graphId:string):Promise<Data[]> {return rows(db,"SELECT id,kind,title,description,body FROM graph_nodes WHERE graph_id=? AND kind!='goal'",graphId)}

export async function advanceGrading(db:D1Database,g:Graph):Promise<void> {
 const head=await sql(db,"SELECT * FROM graph_grading WHERE graph_id=? AND status!='done' ORDER BY sequence LIMIT 1",g.id).first<{sequence:number;stage:'grade'|'project';assignment_id:string|null;execution_result_id:string}>()
 if(!head||head.assignment_id) return
 const r=(await sql(db,'SELECT * FROM graph_results WHERE id=?',head.execution_result_id).first<Result>())!
 if(r.status!=='accepted')return
 const {original}=await resolve(db,r)
 const evidence=await rows(db,'SELECT * FROM graph_evidence WHERE source_result_id=?',r.id)
 const context:Data={execution_result_id:r.id,result:JSON.parse(r.parsed!),plan:JSON.parse(original.input),evidence}
 if(head.stage==='project'){const c=await configuration(db,g);context.private_goal=g.body;context.rule=c.rule}
 const next=await assignment(db,g,head.stage,context,{edge:original.edge_id,parent:original.id,node:original.node_id})
 await commit(db,g,'grading_queued',next.id,{},[...next.statements,sql(db,"UPDATE graph_grading SET assignment_id=?,status='running' WHERE sequence=?",next.id,head.sequence)])
}

export async function dispatch(env:GraphEnv,g:Graph):Promise<void> {
 const db=env.DB,c=await configuration(db,g), now=Date.now()
 const budgets=(await sql(db,'SELECT * FROM graph_budgets WHERE graph_id=?',g.id).first<{attempts:number;execution_cost:number;recovery_reserved:number;allocations:number}>())!
 if(budgets.attempts>=c.policy.attempt_budget) return
 const pending=await rows<Assignment>(db,"SELECT * FROM graph_assignments WHERE graph_id=? AND status='pending' AND available_at<=? ORDER BY CASE role WHEN 'undo' THEN 0 WHEN 'reconcile' THEN 0 WHEN 'grade' THEN 1 WHEN 'project' THEN 1 WHEN 'continue' THEN 1 ELSE 2 END,priority DESC,created_at",g.id,now)
 const used=await rows<{agent_id:string;kind:string;graph_id:string}>(db,'SELECT * FROM graph_reservations')
 let executions=used.filter(r=>r.kind==='execution' && (r as {graph_id?:string}).graph_id===g.id).length
 const candidates=budgets.allocations%5===4?[...pending.filter(a=>a.role!=='execute'),...pending.filter(a=>a.role==='execute').reverse()]:pending
 for(const a of candidates) {
  if(g.status!=='running'&&!['undo','reconcile','grade','project','continue','repair'].includes(a.role)) continue
  if(a.attempt_count>=a.max_attempts) continue
  if(a.role==='execute'&&executions>=c.policy.capacity) continue
  const agentIds = a.role==='decompose'?[c.policy.decomposer]:['grade','project','continue','reconcile'].includes(a.role)?[c.policy.grader,...(c.policy.fallback?[c.policy.fallback]:[])]:c.policy.agents
  const agent=agentIds.find(x=>!used.some(r=>r.agent_id===x) && (a.role!=='execute'||x!==c.policy.grader))
  if(!agent) continue
  const ready=await sql(db,"SELECT a.id FROM agents a LEFT JOIN agent_state s ON s.agent_id=a.id WHERE a.id=? AND a.team_id=? AND a.paused=0 AND a.status='idle' AND (s.current_task_id IS NULL) AND NOT EXISTS(SELECT 1 FROM tasks WHERE agent_id=a.id AND status='pending')",agent,g.team_id).first()
  if(!ready) continue
  // Only daemons explicitly advertising isolation support may receive graph execution.
  if(actionable(a.role)) {
   const capable=await sql(db,'SELECT 1 FROM graph_agent_capabilities WHERE agent_id=? AND version>=1 AND seen_at>?',agent,now-300_000).first()
   if(!capable) continue
  }
  let cost=0,recovery=0
  if(a.role==='execute') {
   const plan=JSON.parse(a.input).plan
   cost=Number(plan.cost); recovery=Number(plan.recovery_cost)
   if(budgets.execution_cost+cost>c.policy.cost_budget||budgets.recovery_reserved+recovery>c.policy.recovery_budget) continue
  }
  const planningCount=await sql(db,"SELECT COUNT(*) AS n FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=? AND a.role IN ('decompose','plan','merge')",g.id).first<{n:number}>()
  if(['decompose','plan','merge'].includes(a.role)&&(planningCount?.n??0)>=c.policy.planning_budget) continue
  const task=id(),attempt=id(),epoch=a.attempt_count+1
  await commit(db,g,'dispatched',a.id,{task_id:task,attempt_id:attempt,agent_id:agent},[
   sql(db,"INSERT INTO tasks(id,team_id,agent_id,sender_id,subject,status,auto_close,close_steps,created_at) VALUES(?,?,?,?,?,'pending',1,'[]',?)",task,g.team_id,agent,g.owner_id,`[Graph] ${a.role}`,now),
   sql(db,"INSERT INTO messages(id,task_id,sender_id,role,type,body,created_at) VALUES(?,?,?,'user','inbox',?,?)",id(),task,g.owner_id,a.template,now),
   sql(db,'INSERT INTO graph_attempts(id,assignment_id,task_id,agent_id,epoch,deadline,context_hash,created_at) VALUES(?,?,?,?,?,?,?,?)',attempt,a.id,task,agent,epoch,now+c.policy.deadline_ms,await hash(a.input),now),
   sql(db,"UPDATE graph_assignments SET status='running',attempt_count=? WHERE id=?",epoch,a.id),
   sql(db,'INSERT INTO graph_reservations(agent_id,attempt_id,graph_id,kind,created_at) VALUES(?,?,?,?,?)',agent,attempt,g.id,a.role==='execute'?'execution':'control',now),
   sql(db,'UPDATE graph_budgets SET attempts=attempts+1,execution_cost=execution_cost+?,recovery_reserved=recovery_reserved+?,allocations=allocations+? WHERE graph_id=?',cost,recovery,a.role==='execute'?1:0,g.id),
  ])
  await bumpInboxVersion(env,agent)
  budgets.attempts++;budgets.execution_cost+=cost;budgets.recovery_reserved+=recovery
  used.push({agent_id:agent,kind:a.role==='execute'?'execution':'control',graph_id:g.id})
  if(a.role==='execute')executions++
  if(budgets.attempts>=c.policy.attempt_budget)break
 }
}

export async function tick(env:GraphEnv,graphId:string):Promise<void> {
 const g=await graph(env.DB,graphId)
 await processResults(env.DB,g)
 await advanceGrading(env.DB,g)
 await dispatch(env,g)
}

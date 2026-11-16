import { ulid } from 'ulidx'
import type { Env } from '../types.js'
import { hash, policy, prompt, templates, type Policy, type Role, type Rule, verifyGoal } from './contracts.js'

export interface Graph {
 id: string; team_id: string; owner_id: string; title: string; description: string; body: string
 start_state: string; status: string; version: number; created_at: number; updated_at: number
}
export interface Assignment {
 id: string; graph_id: string; role: Role; node_id: string | null; edge_id: string | null
 parent_id: string | null; config_version: number; template_hash: string; template: string
 input: string; status: string; attempt_count: number; max_attempts: number; available_at: number; priority: number
}
export interface Attempt {
 id: string; assignment_id: string; task_id: string; agent_id: string; session_id: string | null
 epoch: number; status: string; deadline: number
}
export interface Result {
 id: string; attempt_id: string; raw: string; parsed: string | null; output_hash: string; status: string; created_at: number
}
export interface Node { id: string; graph_id: string; kind: string; title: string; description: string; body: string; created_at: number }
export type Data = Record<string, unknown>
export const id = () => ulid()
export const json = (value: unknown) => JSON.stringify(value)
export const sql = (db: D1Database, query: string, ...args: unknown[]) => db.prepare(query).bind(...args)
export async function rows<T>(db: D1Database, query: string, ...args: unknown[]): Promise<T[]> {
 return (await sql(db, query, ...args).all<T>()).results
}
export async function graph(db: D1Database, graphId: string): Promise<Graph> {
 const g = await sql(db, 'SELECT * FROM graphs WHERE id=?', graphId).first<Graph>()
 if (!g) throw new Error('Graph not found')
 return g
}
export async function configuration(db: D1Database, g: Graph): Promise<{ policy: Policy; rule: Rule; version: number }> {
 const c = await sql(db, 'SELECT * FROM graph_configs WHERE graph_id=? ORDER BY version DESC LIMIT 1', g.id).first<{ policy: string; success_rule: string; version: number }>()
 if (!c) throw new Error('Missing graph configuration')
 return { policy: JSON.parse(c.policy), rule: JSON.parse(c.success_rule), version: c.version }
}

/** Unique version claim makes concurrent stale batches roll back in D1. */
export async function commit(db: D1Database, g: Graph, kind: string, entity: string | null, data: unknown, operations: D1PreparedStatement[]): Promise<void> {
 const now = Date.now()
 await db.batch([
  sql(db, 'INSERT INTO graph_commits(graph_id,version,id,created_at) VALUES(?,?,?,?)', g.id, g.version + 1, id(), now),
  sql(db, 'UPDATE graphs SET version=version+1,updated_at=? WHERE id=? AND version=?', now, g.id, g.version),
  ...operations,
  sql(db, 'INSERT INTO graph_events(graph_id,kind,entity_id,data,created_at) VALUES(?,?,?,?,?)', g.id, kind, entity, json(data), now),
  ...['snapshot','index'].map(kind => sql(db, 'INSERT INTO graph_outbox(graph_id,graph_version,kind,available_at) VALUES(?,?,?,?)', g.id, g.version+1, kind, now)),
 ])
 g.version++
}

export async function assignment(db: D1Database, g: Graph, role: Role, input: unknown, links: { node?: string | null; edge?: string | null; parent?: string | null; priority?: number; originalRole?: keyof typeof templates } = {}): Promise<{ id: string; statements: D1PreparedStatement[] }> {
 const c = await configuration(db, g)
 const assignmentId = id(), body = prompt(role, input, links.originalRole)
 return { id: assignmentId, statements: [sql(db, `INSERT INTO graph_assignments
 (id,graph_id,role,node_id,edge_id,parent_id,config_version,template_hash,template,input,max_attempts,available_at,created_at,priority)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, assignmentId,g.id,role,links.node??null,links.edge??null,links.parent??null,c.version,await hash(body),body,json(input),c.policy.max_attempts,Date.now(),Date.now(),links.priority??.5)] }
}

export function nodeStatements(db: D1Database, g: Graph, kind: string, content: Data, source: string | null, parent: string | null = null): { id: string; statements: D1PreparedStatement[] } {
 const nodeId = id(), now = Date.now()
 return { id: nodeId, statements: [
  sql(db, 'INSERT INTO graph_nodes(id,graph_id,kind,title,description,body,parent_id,source_result_id,necessity,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', nodeId,g.id,kind,content.title,content.description,content.body,parent,source,content.necessity_confidence??null,now),
  sql(db, 'INSERT INTO graph_node_states(graph_id,node_id,state,created_at) VALUES(?,?,?,?)',g.id,nodeId,'active',now),
 ] }
}

export async function create(db: D1Database, teamId: string, ownerId: string, data: Data): Promise<Graph> {
 const p = policy(data.policy as Partial<Policy>), rule = data.rule as Rule
 if (!rule || !['AND','OR'].includes(rule.op) || !Array.isArray(rule.predicates) || !rule.predicates.length || rule.predicates.length > 20 || rule.predicates.some(p => typeof p !== 'string' || !p.trim() || p.length>299) || typeof rule.scope !== 'string' || !rule.scope.trim()) throw new Error('A nonempty scoped sufficient success rule is required')
 for (const [key,max] of [['title',299],['description',299],['body',3999],['start_state',3999]] as const) {
  if (typeof data[key] !== 'string' || [...(data[key] as string).normalize('NFC')].length>max || (key==='title' && !(data[key] as string).trim())) throw new Error(`Invalid ${key}`)
  data[key] = (data[key] as string).normalize('NFC')
 }
 const agents = [...new Set([...p.agents,p.grader,p.decomposer,...(p.fallback?[p.fallback]:[])])]
 for (const agent of agents) if (!await sql(db,'SELECT id FROM agents WHERE id=? AND team_id=?',agent,teamId).first()) throw new Error('Agents must belong to this project')
 const now = Date.now(), graphId = id()
 const g: Graph = { id:graphId, team_id:teamId,owner_id:ownerId,title:data.title as string,description:data.description as string,body:data.body as string,start_state:data.start_state as string,status:'draft',version:1,created_at:now,updated_at:now }
 const start = nodeStatements(db,g,'observed',{title:'Observed start',description:'',body:g.start_state},null)
 const goal = nodeStatements(db,g,'goal',{title:g.title,description:g.description,body:g.body},null)
 await db.batch([
  sql(db,'INSERT INTO graphs(id,team_id,owner_id,title,description,body,start_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',g.id,teamId,ownerId,g.title,g.description,g.body,g.start_state,now,now),
  sql(db,'INSERT INTO graph_configs(graph_id,version,policy,success_rule,created_at) VALUES(?,1,?,?,?)',g.id,json(p),json(rule),now),
  ...start.statements,...goal.statements,
  sql(db,'INSERT INTO graph_budgets(graph_id) VALUES(?)',g.id),
  ...['cleanup','revival','decomposition','timeout'].map(k=>sql(db,'INSERT INTO graph_maintenance(graph_id,kind,next_at) VALUES(?,?,?)',g.id,k,now+p.maintenance_ms)),
  sql(db,'INSERT INTO graph_events(graph_id,kind,data,created_at) VALUES(?,?,?,?)',g.id,'created',json({}),now),
  ...['snapshot','index'].map(k=>sql(db,'INSERT INTO graph_outbox(graph_id,graph_version,kind,available_at) VALUES(?,1,?,?)',g.id,k,now)),
 ])
 return g
}

export async function snapshot(db: D1Database, g: Graph): Promise<Data> {
 const c = await configuration(db,g)
 const [nodes,edges,assignments,attempts,results,events,resources,evidence,budgets,grading,evaluations,proposals] = await Promise.all([
  rows(db,`SELECT n.*,s.state,s.reason FROM graph_nodes n LEFT JOIN graph_node_states s ON s.id=(SELECT MAX(id) FROM graph_node_states WHERE node_id=n.id) WHERE n.graph_id=?`,g.id),
  rows(db,'SELECT e.*,p.baseline,p.predicates,p.steps,p.undo_steps,p.cost,p.recovery_cost,p.resource_versions,p.effects FROM graph_edges e LEFT JOIN graph_plans p ON p.edge_id=e.id WHERE e.graph_id=?',g.id),
  rows(db,'SELECT * FROM graph_assignments WHERE graph_id=? ORDER BY created_at',g.id),
  rows(db,'SELECT t.* FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=?',g.id),
  rows(db,'SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=?',g.id),
  rows(db,'SELECT * FROM graph_events WHERE graph_id=? ORDER BY sequence DESC LIMIT 500',g.id),
  rows(db,'SELECT * FROM graph_resources WHERE graph_id=?',g.id),
  rows<{ predicate:string;value:'true'|'false'|'unknown';scope:string;expires_at:number }>(db,'SELECT * FROM graph_evidence WHERE graph_id=?',g.id),
  sql(db,'SELECT * FROM graph_budgets WHERE graph_id=?',g.id).first(),
  rows(db,'SELECT * FROM graph_grading WHERE graph_id=? ORDER BY sequence',g.id),
  rows(db,'SELECT * FROM graph_evaluations WHERE graph_id=? ORDER BY id',g.id),
  rows(db,'SELECT * FROM graph_proposals WHERE graph_id=?',g.id),
 ])
 return { ...g, config:c, nodes,edges,assignments,attempts,results,events,resources,evidence,budgets,grading,evaluations,proposals,goal_verification:verifyGoal(c.rule,evidence,Date.now()) }
}

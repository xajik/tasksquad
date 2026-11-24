import { ulid } from 'ulidx'
import {
  hash,
  policy,
  prompt,
  skillInstruction,
  templates,
  type Policy,
  type Role,
  type Rule,
  verifyGoal
} from './contracts.js'

export interface Graph {
  id: string
  team_id: string
  owner_id: string
  title: string
  description: string
  body: string
  start_state: string
  status: string
  version: number
  created_at: number
  updated_at: number
}
export interface Assignment {
  id: string
  graph_id: string
  role: Role
  node_id: string | null
  edge_id: string | null
  parent_id: string | null
  config_version: number
  template_hash: string
  template: string
  input: string
  status: string
  cancel_reason?: string | null
  attempt_count: number
  max_attempts: number
  available_at: number
  priority: number
}
export interface Attempt {
  id: string
  assignment_id: string
  task_id: string
  agent_id: string
  session_id: string | null
  epoch: number
  status: string
  deadline: number
}
export interface Result {
  id: string
  attempt_id: string
  raw: string
  parsed: string | null
  output_hash: string
  status: string
  created_at: number
}
export type Data = Record<string, unknown>
export const id = () => ulid()
/** Frees an execution plan's reserved recovery budget (never below zero). */
export const releaseRecovery = (db: D1Database, graphId: string, recoveryCost: number) =>
  db
    .prepare('UPDATE graph_budgets SET recovery_reserved=MAX(0,recovery_reserved-?) WHERE graph_id=?')
    .bind(recoveryCost, graphId)
export const json = (value: unknown) => JSON.stringify(value)
export const sql = (db: D1Database, query: string, ...args: unknown[]) => db.prepare(query).bind(...args)
export async function rows<T = Data>(db: D1Database, query: string, ...args: unknown[]): Promise<T[]> {
  return (await sql(db, query, ...args).all<T>()).results
}
export async function graph(db: D1Database, graphId: string): Promise<Graph> {
  const g = await sql(db, 'SELECT * FROM graphs WHERE id=?', graphId).first<Graph>()
  if (!g) throw new Error('Graph not found')
  return g
}
export async function configuration(
  db: D1Database,
  g: Graph
): Promise<{ policy: Policy; rule: Rule; version: number }> {
  const c = await sql(
    db,
    'SELECT * FROM graph_configs WHERE graph_id=? ORDER BY version DESC LIMIT 1',
    g.id
  ).first<{ policy: string; success_rule: string; version: number }>()
  if (!c) throw new Error('Missing graph configuration')
  return { policy: JSON.parse(c.policy), rule: JSON.parse(c.success_rule), version: c.version }
}

/** Unique version claim makes concurrent stale batches roll back in D1. */
export async function commit(
  db: D1Database,
  g: Graph,
  kind: string,
  entity: string | null,
  data: unknown,
  operations: D1PreparedStatement[]
): Promise<void> {
  const now = Date.now()
  await db.batch([
    sql(
      db,
      'INSERT INTO graph_commits(graph_id,version,id,created_at) VALUES(?,?,?,?)',
      g.id,
      g.version + 1,
      id(),
      now
    ),
    sql(
      db,
      'UPDATE graphs SET version=version+1,updated_at=? WHERE id=? AND version=?',
      now,
      g.id,
      g.version
    ),
    ...operations,
    sql(
      db,
      'INSERT INTO graph_events(graph_id,kind,entity_id,data,created_at) VALUES(?,?,?,?,?)',
      g.id,
      kind,
      entity,
      json(data),
      now
    ),
    ...['snapshot', 'index'].map((kind) =>
      sql(
        db,
        'INSERT INTO graph_outbox(graph_id,graph_version,kind,available_at) VALUES(?,?,?,?)',
        g.id,
        g.version + 1,
        kind,
        now
      )
    )
  ])
  g.version++
}

/** Role identity comes from the team's Skills page (`tsq-graph-<role>`, team copy beats the default);
 * the built-in template instruction is only the fallback. */
export async function roleInstruction(db: D1Database, g: Graph, role: Role): Promise<string | undefined> {
  const row = await sql(
    db,
    `SELECT content FROM skills WHERE name=? AND (team_id=? OR is_default=1)
     ORDER BY (team_id IS NOT NULL) DESC LIMIT 1`,
    `tsq-graph-${role}`,
    g.team_id
  ).first<{ content: string }>()
  return row ? skillInstruction(row.content) || undefined : undefined
}

export async function assignment(
  db: D1Database,
  g: Graph,
  role: Role,
  input: unknown,
  links: {
    node?: string | null
    edge?: string | null
    parent?: string | null
    priority?: number
    originalRole?: keyof typeof templates
  } = {}
): Promise<{ id: string; statements: D1PreparedStatement[] }> {
  const c = await configuration(db, g)
  const assignmentId = id(),
    body = prompt(role, input, links.originalRole, await roleInstruction(db, g, role))
  return {
    id: assignmentId,
    statements: [
      sql(
        db,
        `INSERT INTO graph_assignments
 (id,graph_id,role,node_id,edge_id,parent_id,config_version,template_hash,template,input,max_attempts,available_at,created_at,priority)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        assignmentId,
        g.id,
        role,
        links.node ?? null,
        links.edge ?? null,
        links.parent ?? null,
        c.version,
        await hash(body),
        body,
        json(input),
        c.policy.max_attempts,
        Date.now(),
        Date.now(),
        links.priority ?? 0.5
      )
    ]
  }
}

export function nodeStatements(
  db: D1Database,
  g: Graph,
  kind: string,
  content: Data,
  source: string | null,
  parent: string | null = null
): { id: string; statements: D1PreparedStatement[] } {
  const nodeId = id(),
    now = Date.now()
  return {
    id: nodeId,
    statements: [
      sql(
        db,
        'INSERT INTO graph_nodes(id,graph_id,kind,title,description,body,parent_id,source_result_id,necessity,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        nodeId,
        g.id,
        kind,
        content.title,
        content.description,
        content.body,
        parent,
        source,
        content.necessity_confidence ?? null,
        now
      ),
      sql(
        db,
        'INSERT INTO graph_node_states(graph_id,node_id,state,created_at) VALUES(?,?,?,?)',
        g.id,
        nodeId,
        'active',
        now
      )
    ]
  }
}

export async function create(db: D1Database, teamId: string, ownerId: string, data: Data): Promise<Graph> {
  const p = policy(data.policy as Partial<Policy>),
    rule = data.rule as Rule
  if (
    !rule ||
    !['AND', 'OR'].includes(rule.op) ||
    !Array.isArray(rule.predicates) ||
    !rule.predicates.length ||
    rule.predicates.length > 20 ||
    rule.predicates.some((p) => typeof p !== 'string' || !p.trim() || p.length > 299) ||
    typeof rule.scope !== 'string' ||
    !rule.scope.trim()
  )
    throw new Error('A nonempty scoped sufficient success rule is required')
  for (const [key, max] of [
    ['title', 299],
    ['description', 299],
    ['body', 3999],
    ['start_state', 3999]
  ] as const) {
    if (
      typeof data[key] !== 'string' ||
      [...(data[key] as string).normalize('NFC')].length > max ||
      (key === 'title' && !(data[key] as string).trim())
    )
      throw new Error(`Invalid ${key}`)
    data[key] = (data[key] as string).normalize('NFC')
  }
  const agents = [...new Set([...p.agents, p.grader, p.decomposer, ...(p.fallback ? [p.fallback] : [])])]
  for (const agent of agents)
    if (!(await sql(db, 'SELECT id FROM agents WHERE id=? AND team_id=?', agent, teamId).first()))
      throw new Error('Agents must belong to this project')
  const now = Date.now(),
    graphId = id()
  const g: Graph = {
    id: graphId,
    team_id: teamId,
    owner_id: ownerId,
    title: data.title as string,
    description: data.description as string,
    body: data.body as string,
    start_state: data.start_state as string,
    status: 'draft',
    version: 1,
    created_at: now,
    updated_at: now
  }
  const start = nodeStatements(
    db,
    g,
    'observed',
    { title: 'Observed start', description: '', body: g.start_state },
    null
  )
  const goal = nodeStatements(
    db,
    g,
    'goal',
    { title: g.title, description: g.description, body: g.body },
    null
  )
  await db.batch([
    sql(
      db,
      'INSERT INTO graphs(id,team_id,owner_id,title,description,body,start_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      g.id,
      teamId,
      ownerId,
      g.title,
      g.description,
      g.body,
      g.start_state,
      now,
      now
    ),
    sql(
      db,
      'INSERT INTO graph_configs(graph_id,version,policy,success_rule,created_at) VALUES(?,1,?,?,?)',
      g.id,
      json(p),
      json(rule),
      now
    ),
    ...start.statements,
    ...goal.statements,
    // Evidence must cite a supplied resource, so every graph starts with its declared evidence source.
    sql(
      db,
      "INSERT INTO graph_resources(id,graph_id,version,title,description,body,visibility,created_at) VALUES(?,?,1,?,?,?,'execution',?)",
      id(),
      g.id,
      `Evidence source · ${(rule.scope as string).normalize('NFC').slice(0, 250)}`,
      'Default source for evidence within the success rule scope.',
      `Observations reported for scope "${(rule.scope as string).normalize('NFC').slice(0, 250)}". Cite this resource as evidence.resource_id.`,
      now
    ),
    sql(db, 'INSERT INTO graph_budgets(graph_id) VALUES(?)', g.id),
    ...['cleanup', 'revival', 'decomposition', 'timeout'].map((k) =>
      sql(
        db,
        'INSERT INTO graph_maintenance(graph_id,kind,next_at) VALUES(?,?,?)',
        g.id,
        k,
        now + p.maintenance_ms
      )
    ),
    sql(
      db,
      'INSERT INTO graph_events(graph_id,kind,data,created_at) VALUES(?,?,?,?)',
      g.id,
      'created',
      json({}),
      now
    ),
    ...['snapshot', 'index'].map((k) =>
      sql(
        db,
        'INSERT INTO graph_outbox(graph_id,graph_version,kind,available_at) VALUES(?,1,?,?)',
        g.id,
        k,
        now
      )
    )
  ])
  return g
}

// Clone a closed graph: always the goal, start state, policy and success rule (fresh start);
// optionally the node/edge structure with plans, resources and tags (no results, evidence or history).
export async function clone(
  db: D1Database,
  teamId: string,
  userId: string,
  sourceId: string,
  withNodes: boolean
): Promise<Graph> {
  const src = await graph(db, sourceId)
  if (src.team_id !== teamId) throw new Error('Graph not found')
  if (src.status !== 'stopped') throw new Error('Only closed graphs can be cloned')
  const c = await configuration(db, src)
  const g = await create(db, teamId, userId, {
    title: `${src.title} (copy)`.slice(0, 299),
    description: src.description,
    body: src.body,
    start_state: src.start_state,
    policy: c.policy,
    rule: c.rule
  })
  if (!withNodes) return g
  const map = new Map<string, string>()
  const fresh = await rows<{ id: string; kind: string }>(
    db,
    "SELECT id,kind FROM graph_nodes WHERE graph_id=? AND kind IN ('observed','goal')",
    g.id
  )
  for (const k of ['observed', 'goal']) {
    const from = await db
      .prepare('SELECT id FROM graph_nodes WHERE graph_id=? AND kind=? ORDER BY created_at LIMIT 1')
      .bind(sourceId, k)
      .first<{ id: string }>()
    const to = fresh.find((n) => n.kind === k)
    if (from && to) map.set(from.id, to.id)
  }
  const nodes = await rows<Data>(
    db,
    "SELECT * FROM graph_nodes WHERE graph_id=? AND kind NOT IN ('observed','goal') ORDER BY created_at,rowid",
    sourceId
  )
  const edges = await rows<Data>(
    db,
    'SELECT * FROM graph_edges WHERE graph_id=? ORDER BY created_at',
    sourceId
  )
  const plans = await rows<Data>(
    db,
    'SELECT p.* FROM graph_plans p JOIN graph_edges e ON e.id=p.edge_id WHERE e.graph_id=?',
    sourceId
  )
  const resources = await rows<Data>(
    db,
    'SELECT * FROM graph_resources WHERE graph_id=? ORDER BY created_at',
    sourceId
  )
  const links = await rows<Data>(
    db,
    'SELECT l.* FROM graph_resource_links l JOIN graph_resources r ON r.id=l.resource_id WHERE r.graph_id=?',
    sourceId
  )
  const tags = await rows<Data>(db, 'SELECT * FROM graph_tags WHERE graph_id=?', sourceId)
  for (const n of nodes) map.set(n.id as string, id())
  const resMap = new Map<string, string>()
  for (const r of resources) resMap.set(r.id as string, id())
  const now = Date.now(),
    ops: D1PreparedStatement[] = []
  for (const n of nodes)
    ops.push(
      sql(
        db,
        'INSERT INTO graph_nodes(id,graph_id,kind,title,description,body,parent_id,source_result_id,necessity,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        map.get(n.id as string),
        g.id,
        n.kind,
        n.title,
        n.description,
        n.body,
        n.parent_id ? (map.get(n.parent_id as string) ?? null) : null,
        n.source_result_id,
        n.necessity,
        now
      ),
      sql(
        db,
        "INSERT INTO graph_node_states(graph_id,node_id,state,created_at) VALUES(?,?,'active',?)",
        g.id,
        map.get(n.id as string),
        now
      )
    )
  const edgeMap = new Map<string, string>()
  for (const e of edges) {
    const from = map.get(e.from_id as string),
      to = map.get(e.to_id as string)
    if (!from || !to) continue
    edgeMap.set(e.id as string, id())
    ops.push(
      sql(
        db,
        'INSERT INTO graph_edges(id,graph_id,from_id,to_id,title,description,body,source_result_id,created_at,expected_score) VALUES(?,?,?,?,?,?,?,?,?,?)',
        edgeMap.get(e.id as string),
        g.id,
        from,
        to,
        e.title,
        e.description,
        e.body,
        e.source_result_id,
        now,
        e.expected_score ?? null
      )
    )
  }
  for (const p of plans) {
    const edge = edgeMap.get(p.edge_id as string)
    if (edge)
      ops.push(
        sql(
          db,
          'INSERT INTO graph_plans(edge_id,baseline,predicates,steps,undo_steps,cost,recovery_cost,resource_versions,effects) VALUES(?,?,?,?,?,?,?,?,?)',
          edge,
          p.baseline,
          p.predicates,
          p.steps,
          p.undo_steps,
          p.cost,
          p.recovery_cost,
          p.resource_versions,
          p.effects
        )
      )
  }
  for (const r of resources)
    ops.push(
      sql(
        db,
        'INSERT INTO graph_resources(id,graph_id,version,title,description,body,visibility,r2_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        resMap.get(r.id as string),
        g.id,
        r.version,
        r.title,
        r.description,
        r.body,
        r.visibility,
        r.r2_key,
        now
      )
    )
  for (const l of links) {
    const r = resMap.get(l.resource_id as string),
      n = map.get(l.node_id as string)
    if (r && n) ops.push(sql(db, 'INSERT INTO graph_resource_links(resource_id,node_id) VALUES(?,?)', r, n))
  }
  for (const t of tags) {
    const n = map.get(t.node_id as string)
    if (n) ops.push(sql(db, 'INSERT INTO graph_tags(graph_id,node_id,tag) VALUES(?,?,?)', g.id, n, t.tag))
  }
  for (let i = 0; i < ops.length; i += 90) await db.batch(ops.slice(i, i + 90))
  return g
}

/** The interactive view needs only a few input fields (titles and links between assignments); the rest, with the role template, is fetched never. */
function slimAssignment(a: Assignment): Data {
  const { template: _template, ...rest } = a as Assignment & { template?: string }
  let input = rest.input
  try {
    const full = JSON.parse(String(rest.input)) as Data
    const keep: Data = {}
    for (const k of ['proposal_id', 'execution_result_id', 'title', 'operation'])
      if (full[k] !== undefined) keep[k] = full[k]
    const title = (full.plan as { title?: unknown } | undefined)?.title
    if (title !== undefined) keep.plan = { title }
    input = JSON.stringify(keep)
  } catch {
    /* keep the original text when it is not JSON */
  }
  return { ...rest, input }
}

/** Why a step is blocked when the agent asked for nothing: its own report, else the validation error. */
function blockedReason(result: Data | undefined, status: string): string {
  let reported = ''
  try {
    const p = JSON.parse(String(result?.parsed ?? '')) as { title?: string; description?: string }
    reported = [p.title, p.description].filter(Boolean).join(' — ')
  } catch {
    /* unparsed result */
  }
  const why = reported || String(result?.validation_error || '')
  const prefix = status === 'error' ? 'Failed' : 'Blocked'
  return `${prefix}${why ? `: ${why}` : ''}. The agent asked for no approval — fix what it is missing and reply in the inbox task to retry, or abandon the step.`
}

export async function snapshot(db: D1Database, g: Graph, enabled = true, slim = false): Promise<Data> {
  const c = await configuration(db, g)
  const [
    nodes,
    edges,
    assignments,
    attempts,
    results,
    events,
    resources,
    evidence,
    budgets,
    grading,
    evaluations,
    proposals
  ] = await Promise.all([
    rows(
      db,
      `SELECT n.*,s.state,s.reason,s.created_at AS state_changed_at FROM graph_nodes n LEFT JOIN graph_node_states s ON s.id=(SELECT MAX(id) FROM graph_node_states WHERE node_id=n.id) WHERE n.graph_id=?`,
      g.id
    ),
    rows(
      db,
      'SELECT e.*,p.baseline,p.predicates,p.steps,p.undo_steps,p.cost,p.recovery_cost,p.resource_versions,p.effects FROM graph_edges e LEFT JOIN graph_plans p ON p.edge_id=e.id WHERE e.graph_id=?',
      g.id
    ),
    rows<Assignment>(db, 'SELECT * FROM graph_assignments WHERE graph_id=? ORDER BY created_at', g.id),
    rows(
      db,
      'SELECT t.*,task.status AS task_status,task.tui_blocked FROM graph_attempts t JOIN graph_assignments a ON a.id=t.assignment_id JOIN tasks task ON task.id=t.task_id WHERE a.graph_id=?',
      g.id
    ),
    rows(
      db,
      'SELECT r.* FROM graph_results r JOIN graph_attempts t ON t.id=r.attempt_id JOIN graph_assignments a ON a.id=t.assignment_id WHERE a.graph_id=?',
      g.id
    ),
    rows(db, 'SELECT * FROM graph_events WHERE graph_id=? ORDER BY sequence DESC LIMIT 500', g.id),
    rows(db, 'SELECT * FROM graph_resources WHERE graph_id=?', g.id),
    rows<{ predicate: string; value: 'true' | 'false' | 'unknown'; scope: string; expires_at: number }>(
      db,
      'SELECT * FROM graph_evidence WHERE graph_id=?',
      g.id
    ),
    sql(db, 'SELECT * FROM graph_budgets WHERE graph_id=?', g.id).first(),
    rows(db, 'SELECT * FROM graph_grading WHERE graph_id=? ORDER BY sequence', g.id),
    rows(db, 'SELECT * FROM graph_evaluations WHERE graph_id=? ORDER BY id', g.id),
    rows(db, 'SELECT * FROM graph_proposals WHERE graph_id=?', g.id)
  ])
  const tags = await rows<{ node_id: string; tag: string }>(
    db,
    'SELECT * FROM graph_tags WHERE graph_id=?',
    g.id
  )
  const links = await rows(
    db,
    'SELECT l.* FROM graph_resource_links l JOIN graph_resources r ON r.id=l.resource_id WHERE r.graph_id=?',
    g.id
  )
  const { dispatchContext, eligibility } = await import('./eligibility.js')
  const context = await dispatchContext(db, g, enabled)
  const { candidateWeights } = await import('./weights.js')
  const { MaxHeap } = await import('./heap.js')
  const pending = assignments.filter((a) => a.status === 'pending')
  const weights = await candidateWeights(db, g, pending, context.now)
  const heap = new MaxHeap<Assignment>((a, b) =>
    weights.get(a.id)!.weight - weights.get(b.id)!.weight || b.id.localeCompare(a.id)
  )
  // Dispatch sorts candidates before insertion; preserve that exact tree layout,
  // not merely another valid heap with the same highest-priority root.
  const executionCandidates = pending
    .filter((a) => a.role === 'execute' && a.available_at <= context.now)
    .sort((a, b) => weights.get(b.id)!.weight - weights.get(a.id)!.weight || a.id.localeCompare(b.id))
  for (const a of executionCandidates) heap.push(a)
  const serialQueue = await rows(db,
    "SELECT * FROM graph_serial_queue WHERE graph_id=? AND status='pending' ORDER BY sequence", g.id)
  const blockedReviews = new Set(grading.filter((r) => r.status === 'blocked').map((r) => String(r.assignment_id)))
  const waiting: Record<string, unknown> = {}
  const { extractApprovalRequest } = await import('../approval.js')
  // Index once instead of rescanning every attempt and result per assignment, and run the
  // per-assignment eligibility queries concurrently: they dominated the response time.
  const attemptsBy = new Map<string, typeof attempts>()
  for (const t of attempts) {
    const list = attemptsBy.get(String(t.assignment_id)) ?? []
    list.push(t)
    attemptsBy.set(String(t.assignment_id), list)
  }
  const resultsBy = new Map<string, typeof results>()
  for (const r of results) {
    const list = resultsBy.get(String(r.attempt_id)) ?? []
    list.push(r)
    resultsBy.set(String(r.attempt_id), list)
  }
  const entries = await Promise.all(assignments.map(async (a) => {
    const latest = (attemptsBy.get(a.id) ?? [])
      .sort(
        (x, y) =>
          Number(y.epoch) - Number(x.epoch) ||
          Number(y.created_at) - Number(x.created_at) ||
          String(y.id).localeCompare(String(x.id))
      )[0]
    const result = (resultsBy.get(String(latest?.id)) ?? [])
      .sort((x, y) => Number(y.created_at) - Number(x.created_at))[0]
    const request = extractApprovalRequest(String(result?.parsed ?? result?.raw ?? ''))
    const canReply =
      ['blocked', 'error'].includes(a.status) &&
      a.role !== 'repair' &&
      latest &&
      !['done', 'failed', 'cancelled'].includes(String(latest.task_status))
    const detail =
      blockedReviews.has(a.id)
        ? { code: 'review_failed', message: `Review failed after ${a.attempt_count} / ${a.max_attempts} attempts${latest?.status ? ` (last attempt: ${latest.status})` : ''}. Grading is incomplete. Independent work can continue; retry or cancel this review in the graph work queue.` }
        : a.status === 'pending'
        ? await eligibility(a, context)
        : a.status === 'review'
          ? { code: 'review', message: 'An owner or maintainer must review this result.' }
          : canReply
            ? request
              ? {
                  code: 'owner_input',
                  message: request.reason || request.title || String(result?.validation_error || 'Reply in the latest inbox task to continue.')
                }
              : {
                  // The agent stopped on its own ("blocked") without asking anything, so there is
                  // nothing to approve: surface its reason instead of a generic reply prompt.
                  code: 'blocked',
                  message: blockedReason(result, a.status)
                }
            : a.status === 'continuation'
              ? {
                  code: 'continuation',
                  message: 'Input received. Follow the continuation task for the next decision.'
                }
              : ['reconciling', 'restoring'].includes(a.status) ||
                  (a.role === 'repair' && ['pending', 'running'].includes(a.status))
                ? { code: 'recovery', message: 'Recovery in progress.' }
                : null
    return detail
      ? ([a.id, {
        code: detail.code,
        message: detail.message,
        task_id: latest?.task_id ?? null,
        action: blockedReviews.has(a.id) ? 'view' : a.status === 'review' ? 'review' : canReply ? 'reply' : latest ? 'view' : null,
        request_title: canReply ? (request?.title ?? null) : null,
        has_request: !!request
      }] as const)
      : null
  }))
  for (const entry of entries) if (entry) waiting[entry[0]] = entry[1]
  return {
    ...g,
    config: c,
    nodes: nodes.map((n) => ({
      ...n,
      tags: tags.filter((t) => t.node_id === (n as Data).id).map((t) => t.tag)
    })),
    resource_links: links,
    edges,
    // The page never reads the role template (~10 KB per assignment), so the interactive
    // view omits it; archived snapshots keep the full row.
    assignments: slim ? assignments.map(slimAssignment) : assignments,
    attempts,
    results,
    events,
    resources,
    evidence,
    budgets,
    grading,
    evaluations,
    proposals,
    waiting,
    scheduler: {
      sampled_at: context.now,
      next_selection: (Number(context.budgets.allocations) + 1) % 5 === 0 ? 'lowest' : 'highest',
      candidates: pending.map((a) => ({ assignment_id: a.id, ...weights.get(a.id)! })),
      heap: heap.snapshot().map((a) => a.id),
      serial_queue: serialQueue,
      reservations: context.used.filter((r) => r.graph_id === g.id)
    },
    goal_verification: verifyGoal(c.rule, evidence, Date.now())
  }
}

export async function resource(db: D1Database, graphId: string, body: Data): Promise<void> {
  const g = await graph(db, graphId)
  for (const [key, max] of [
    ['title', 299],
    ['description', 299],
    ['body', 3999]
  ] as const)
    if (typeof body[key] !== 'string' || [...(body[key] as string).normalize('NFC')].length > max)
      throw new Error(`Invalid resource ${key}`)
  if (!['execution', 'private'].includes(body.visibility as string)) throw new Error('Invalid visibility')
  const prior = body.supersedes_id
    ? await sql(
        db,
        'SELECT id,version FROM graph_resources WHERE id=? AND graph_id=?',
        body.supersedes_id,
        g.id
      ).first<{ id: string; version: number }>()
    : null
  if (body.supersedes_id && !prior) throw new Error('Previous resource version outside graph')
  const resourceId = id()
  await commit(db, g, 'resource', resourceId, {}, [
    sql(
      db,
      'INSERT INTO graph_resources(id,graph_id,version,title,description,body,visibility,created_at,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?)',
      resourceId,
      g.id,
      (prior?.version ?? 0) + 1,
      body.title,
      body.description,
      body.body,
      body.visibility,
      Date.now(),
      prior?.id ?? null
    )
  ])
}

export async function annotate(
  db: D1Database,
  graphId: string,
  kind: 'tag' | 'link',
  body: Data
): Promise<void> {
  const g = await graph(db, graphId)
  if (!(await sql(db, 'SELECT id FROM graph_nodes WHERE id=? AND graph_id=?', body.node_id, g.id).first()))
    throw new Error('Node outside graph')
  let operation: D1PreparedStatement
  if (kind === 'tag') {
    if (
      typeof body.tag !== 'string' ||
      ![...body.tag.normalize('NFC')].length ||
      [...body.tag.normalize('NFC')].length > 99
    )
      throw new Error('Invalid tag')
    operation = sql(
      db,
      'INSERT OR IGNORE INTO graph_tags(graph_id,node_id,tag) VALUES(?,?,?)',
      g.id,
      body.node_id,
      body.tag.normalize('NFC')
    )
  } else {
    if (
      !(await sql(
        db,
        'SELECT id FROM graph_resources WHERE id=? AND graph_id=?',
        body.resource_id,
        g.id
      ).first())
    )
      throw new Error('Resource outside graph')
    operation = sql(
      db,
      'INSERT OR IGNORE INTO graph_resource_links(resource_id,node_id) VALUES(?,?)',
      body.resource_id,
      body.node_id
    )
  }
  await commit(db, g, kind, String(body.node_id), body, [operation])
}

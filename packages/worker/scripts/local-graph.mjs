#!/usr/bin/env node
// Local developer harness. Runs the real Worker/API and portal against private Miniflare storage.
import { Miniflare } from 'miniflare'
import { buildSync } from 'esbuild'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(workerRoot, '../..')
const runtime = path.join(root, '.runtime/action-graph-local')
const sandbox = path.join(runtime, 'sandbox')
const apiPort = 8788
const portalPort = 5180
const apiBase = `http://127.0.0.1:${apiPort}`
const portalBase = `http://127.0.0.1:${portalPort}`
const modeIndex = process.argv.indexOf('--agents')
const mode = modeIndex < 0 ? 'claude' : process.argv[modeIndex + 1]
if (!['claude', 'deterministic', 'daemon'].includes(mode))
  throw new Error('--agents must be claude, deterministic or daemon')
const ids = {
  user: 'local-graph-owner',
  team: 'local-graph-project',
  executor: 'local-graph-explorer',
  grader: 'local-graph-reviewer'
}
const phrase = 'TaskSquad local graph works'
const baseline = 'TaskSquad local graph baseline'
const scenario = 'reversible-file-v2'
const tasks = new Map()
let stopping = false
let frontend
let daemon
let mf
let timer
let token
let db
const digest = (value) => createHash('sha256').update(value).digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const query = (statement, ...args) => db.prepare(statement).bind(...args)

async function request(route, data, agent) {
  const response = await fetch(`${apiBase}${route}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(agent ? { 'X-TSQ-Agent': agent } : {})
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(result)}`)
  return result
}

async function migrate() {
  await db
    .prepare('CREATE TABLE IF NOT EXISTS local_graph_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL)')
    .run()
  const applied = new Map(
    (await db.prepare('SELECT name,hash FROM local_graph_migrations').all()).results.map((row) => [
      row.name,
      row.hash
    ])
  )
  for (const filename of (await readdir(path.join(workerRoot, 'migrations')))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const full = path.join(workerRoot, 'migrations', filename),
      hash = digest(await readFile(full, 'utf8'))
    if (applied.has(filename)) {
      if (applied.get(filename) !== hash)
        throw new Error(
          `Applied migration changed: ${filename}. Use a new migration or a fresh local runtime directory.`
        )
      continue
    }
    // SQLite's parser handles semicolons in seeded Markdown and trigger bodies.
    const statements = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `
import sqlite3,json,sys
source=open(sys.argv[1]).read(); pending=''; statements=[]
for char in source:
 pending+=char
 if char==';' and sqlite3.complete_statement(pending):
  statements.append(pending); pending=''
print(json.dumps(statements))
`,
          full
        ],
        { encoding: 'utf8' }
      )
    )
    for (const sql of statements) await db.prepare(sql).run()
    await query('INSERT INTO local_graph_migrations(name,hash) VALUES(?,?)', filename, hash).run()
  }
  // Migration 0016 was historically a no-op after a manual production ALTER.
  // Complete that prerequisite for a fresh, isolated local database.
  const messageColumns = (await db.prepare('PRAGMA table_info(messages)').all()).results
  if (!messageColumns.some((column) => column.name === 'json_payload'))
    await db.prepare('ALTER TABLE messages ADD COLUMN json_payload TEXT').run()
}

async function seed() {
  const now = Date.now()
  const credentialFile = path.join(runtime, 'session.json')
  try {
    token = JSON.parse(await readFile(credentialFile, 'utf8')).token
  } catch {
    token = `tsq_cli_${randomBytes(32).toString('hex')}`
  }
  if (!/^tsq_cli_[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local session file')
  await writeFile(credentialFile, JSON.stringify({ token }), { mode: 0o600 })
  await db.batch([
    query(
      "INSERT OR IGNORE INTO users(id,firebase_uid,email,plan,created_at) VALUES(?,?,?,'pro',?)",
      ids.user,
      ids.user,
      'local-tester@localhost.invalid',
      now
    ),
    query(
      'INSERT OR IGNORE INTO teams(id,name,owner_id,created_at) VALUES(?,?,?,?)',
      ids.team,
      'Action Graph · Local',
      ids.user,
      now
    ),
    query(
      "INSERT OR IGNORE INTO team_members(team_id,user_id,role,joined_at) VALUES(?,?,'owner',?)",
      ids.team,
      ids.user,
      now
    ),
    query(
      "INSERT INTO user_cli_tokens(id,user_id,token_hash,label,expires_at,created_at) VALUES(?,?,?,'Local graph developer session',?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at",
      'local-graph-cli-token',
      ids.user,
      digest(token),
      now + 7 * 86400_000,
      now
    ),
    ...[
      [ids.executor, 'Local Explorer'],
      [ids.grader, 'Local Reviewer']
    ].flatMap(([agent, name]) => [
      query(
        "INSERT OR IGNORE INTO agents(id,team_id,name,status,created_at) VALUES(?,?,?,'idle',?)",
        agent,
        ids.team,
        name,
        now
      ),
      query(
        "INSERT OR IGNORE INTO agent_state(agent_id,mode,viewer_count,updated_at) VALUES(?,'idle',0,?)",
        agent,
        now
      )
    ])
  ])
  // Unclean exits require reconciliation; a restart alone is not proof of termination.
  await query(
    "UPDATE graph_attempts SET deadline=? WHERE agent_id IN (?,?) AND status IN ('pending','running')",
    now,
    ids.executor,
    ids.grader
  ).run()
  const stateFile = path.join(runtime, 'workspace.json')
  let previous
  try {
    previous = JSON.parse(await readFile(stateFile, 'utf8'))
  } catch {
    /* new local workspace */
  }
  if (
    previous?.scenario === scenario &&
    (await query('SELECT id FROM graphs WHERE id=?', previous.graphId).first())
  )
    return previous.graphId
  if (previous?.graphId) await request(`/teams/${ids.team}/graphs/${previous.graphId}/stop`, {})
  try {
    await writeFile(path.join(sandbox, 'verification.txt'), baseline, { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const graph = await request(`/teams/${ids.team}/graphs`, {
    title: 'Local reversible file test',
    description: 'A real inbox workflow using a file in the local sandbox.',
    body: `Use only file tools inside ${sandbox}. Change verification.txt to contain exactly "${phrase}". Verify it independently by reading it. Use predicate verification_file_matches and evidence scope local-sandbox. Do not run shell commands.`,
    start_state: `The sandbox is ${sandbox}. verification.txt initially contains exactly "${baseline}". Baseline resource and files are available for read-only inspection.`,
    rule: { op: 'AND', predicates: ['verification_file_matches'], scope: 'local-sandbox' },
    policy: {
      agents: [ids.executor],
      grader: ids.grader,
      decomposer: ids.executor,
      capacity: 1,
      review: true,
      attempt_budget: 40,
      planning_budget: 15,
      deadline_ms: 10 * 60_000,
      cost_budget: 25,
      recovery_budget: 10
    }
  })
  await request(`/teams/${ids.team}/graphs/${graph.id}/resource`, {
    title: 'Local sandbox baseline',
    description: 'Read-only baseline for the file smoke test.',
    visibility: 'execution',
    body: `Workspace: ${sandbox}. Initially verification.txt contains exactly "${baseline}". The local task is to change that file to exactly "${phrase}" and read it back. For undo, use the Write tool to restore exactly "${baseline}" and read it back; restoration predicate verification_file_baseline. Evidence scope: local-sandbox. Use this resource ID for evidence provenance. Only file tools are available; no shell commands.`
  })
  await writeFile(stateFile, JSON.stringify({ graphId: graph.id, scenario }), { mode: 0o600 })
  return graph.id
}

function evidence(input, predicate, value) {
  const resources = input.resources ?? input.plan?.resources ?? []
  return {
    id: `local-evidence-${randomBytes(12).toString('hex')}`,
    predicate,
    value,
    scope: 'local-sandbox',
    observed_at: Date.now(),
    expires_at: Date.now() + 60 * 60_000,
    resource_id: input.plan?.resource_versions?.[0] ?? resources[0]?.id ?? null
  }
}

async function deterministic(assignment) {
  const input = JSON.parse(assignment.input)
  switch (assignment.role) {
    case 'decompose':
      return {
        subgoals: [
          {
            title: 'Verify the local file',
            description: 'Create and read one sandbox file.',
            body: `Change verification.txt to exactly "${phrase}" in ${sandbox}, then read it.`,
            necessity_confidence: 1
          }
        ]
      }
    case 'merge':
      return {
        decision: 'distinct',
        equivalent_node_id: null,
        reason: 'Independent deterministic fixture review.'
      }
    case 'plan': {
      const source = input.observations?.find((node) => node.kind === 'observed')
      const resource = input.resources?.[0]
      if (!source || !resource) return { actions: [] }
      return {
        actions: [
          {
            title: 'Create verification file',
            description: 'One reversible sandbox write.',
            body: 'local-file-smoke-test',
            from_id: source.id,
            baseline: `verification.txt contains exactly ${baseline}`,
            restoration_predicates: ['verification_file_baseline'],
            steps: [
              `Write verification.txt containing exactly ${phrase}`,
              'Read the file and compare its contents'
            ],
            undo_steps: [
              `Use Write to restore verification.txt to exactly ${baseline}`,
              'Read the file and compare its contents'
            ],
            cost: 1,
            recovery_cost: 1,
            resource_versions: [resource.id],
            effects: ['one sandbox file'],
            expected_quality: 1
          }
        ]
      }
    }
    case 'execute': {
      const file = path.join(sandbox, 'verification.txt')
      if (input.plan?.body !== 'local-file-smoke-test')
        return {
          outcome: 'blocked',
          title: 'Unsupported scripted task',
          description: '',
          body: 'Use Claude mode for arbitrary tasks.',
          evidence: [],
          actual_cost: 0
        }
      const before = await readFile(file, 'utf8').catch(() => null)
      if (before !== baseline && before !== phrase)
        return {
          outcome: 'blocked',
          title: 'Baseline changed',
          description: '',
          body: 'Inspect the sandbox before writing.',
          evidence: [],
          actual_cost: 0
        }
      await writeFile(file, phrase)
      const matches = (await readFile(file, 'utf8')) === phrase
      return {
        outcome: matches ? 'complete' : 'blocked',
        title: 'Local file observation',
        description: '',
        body: 'Read verification.txt in the local sandbox.',
        evidence: [evidence(input, 'verification_file_matches', matches ? 'true' : 'false')],
        actual_cost: 1
      }
    }
    case 'undo': {
      if (!input.plan?.undo_steps?.some((step) => step.includes(baseline)))
        return {
          restored: false,
          title: 'Cannot verify restoration contract',
          description: '',
          body: 'Use a real agent.',
          evidence: []
        }
      await writeFile(path.join(sandbox, 'verification.txt'), baseline)
      return {
        restored: true,
        title: 'Restored baseline',
        description: '',
        body: 'Read back the exact original contents.',
        evidence: [evidence(input, 'verification_file_baseline', 'true')]
      }
    }
    case 'grade':
      return {
        local_score: input.evidence?.length ? 1 : null,
        evidence_ids: (input.evidence ?? []).map((e) => e.id),
        reason: 'Deterministic observation review.'
      }
    case 'project':
      return {
        goal_score: input.evidence?.some(
          (e) => e.predicate === 'verification_file_matches' && e.value === 'true'
        )
          ? 1
          : null,
        evidence_ids: (input.evidence ?? []).map((e) => e.id),
        reason: 'Only the supplied predicate evidence is credited.',
        decomposition_feedback: []
      }
    case 'continue':
      return {
        decision: 'blocked',
        reason: 'Switch to Claude to inspect arbitrary continuation requests.',
        checkpoint_verified: false,
        baseline_unchanged: false,
        termination_verified: false
      }
    case 'reconcile':
      return {
        decision: 'unknown',
        evidence: [],
        reason: 'Reconcile the sandbox with a real agent or human.'
      }
    case 'report':
      return { summary: 'Deterministic local fixture.' }
    default:
      throw new Error(`Scripted mode does not implement ${assignment.role}; inspect the result in the inbox.`)
  }
}

async function claude(assignment, taskId) {
  const toolNames = ['execute', 'undo'].includes(assignment.role)
    ? 'Read,Write,Edit,Glob,Grep'
    : 'Read,Glob,Grep'
  const child = spawn(
    'claude',
    [
      '--print',
      '--output-format',
      'text',
      '--no-session-persistence',
      '--restricted',
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      toolNames,
      '--allowedTools',
      toolNames,
      '--permission-mode',
      'acceptEdits',
      '--permission-prompts',
      'none',
      `${assignment.template}\n\nLocal runtime: your working directory is ${sandbox}. Read local-clock.json for current now_ms and expires_at_ms when reporting timestamped evidence. Use these numbers; do not guess epoch timestamps.`
    ],
    {
      cwd: sandbox,
      env: { ...process.env, CLAUDE_CODE_SAFE_MODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true
    }
  )
  const active = tasks.get(taskId)
  if (active) active.child = child
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (data) => {
    if (stdout.length < 256 * 1024) stdout += data.toString()
  })
  child.stderr.on('data', (data) => {
    if (stderr.length < 256 * 1024) stderr += data.toString()
  })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  await writeFile(
    path.join(runtime, `${taskId}.json`),
    JSON.stringify({ role: assignment.role, code, stdout, stderr }, null, 2),
    { mode: 0o600 }
  )
  if (code !== 0) throw new Error(`Claude exited ${code}; see ${taskId}.json under ${runtime}`)
  return stdout.trim()
}

function kill(child) {
  if (!child?.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  const hard = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 3000)
  hard.unref()
}

async function execute(task) {
  const active = { child: null, agent: task.agent_id }
  tasks.set(task.task_id, active)
  let session
  try {
    const opened = await request('/daemon/session/open', { task_id: task.task_id }, task.agent_id)
    session = opened.session_id
    console.log(`[local agents] ${mode}: ${task.role} started`)
    const assignment = { role: task.role, template: task.template, input: task.input }
    const result =
      mode === 'deterministic'
        ? JSON.stringify(await deterministic(assignment))
        : await claude(assignment, task.task_id)
    if (!stopping)
      await request(
        '/daemon/session/close',
        { session_id: session, status: 'closed', final_text: result },
        task.agent_id
      )
    console.log(`[local agents] ${task.role} finished; result is available in the inbox/Graph review`)
  } catch (error) {
    console.error(`[local agents] ${task.role}: ${error.message}`)
    if (session && !stopping)
      await request(
        '/daemon/session/close',
        { session_id: session, status: 'crashed', final_text: '' },
        task.agent_id
      ).catch((error) => console.error(error.message))
  } finally {
    tasks.delete(task.task_id)
    // Acknowledgement follows actual process exit, never the model's assertion.
    await query(
      'UPDATE graph_attempts SET termination_confirmed_at=? WHERE task_id=?',
      Date.now(),
      task.task_id
    ).run()
    await query("UPDATE agents SET status='idle' WHERE id=?", task.agent_id).run()
    await query(
      "UPDATE agent_state SET current_task_id=NULL,current_session=NULL,mode='idle',updated_at=? WHERE agent_id=? AND current_task_id=?",
      Date.now(),
      task.agent_id,
      task.task_id
    ).run()
  }
}

let polling = false
async function poll() {
  if (polling || stopping) return
  polling = true
  try {
    const now = Date.now()
    await writeFile(
      path.join(sandbox, 'local-clock.json'),
      JSON.stringify({ now_ms: now, expires_at_ms: now + 3600_000 }),
      { mode: 0o600 }
    )
    for (const agent of [ids.executor, ids.grader]) {
      await query(
        'INSERT INTO graph_agent_capabilities(agent_id,version,seen_at) VALUES(?,1,?) ON CONFLICT(agent_id) DO UPDATE SET seen_at=excluded.seen_at',
        agent,
        now
      ).run()
      if ([...tasks.values()].some((task) => task.agent === agent)) continue
      await query("UPDATE agents SET status='idle',last_seen=? WHERE id=?", now, agent).run()
      const task = await query(
        `SELECT t.id AS task_id,t.agent_id,a.role,a.template,a.input FROM tasks t JOIN graph_attempts attempt ON attempt.task_id=t.id JOIN graph_assignments a ON a.id=attempt.assignment_id WHERE t.agent_id=? AND t.status='pending' AND attempt.status='pending' ORDER BY t.created_at LIMIT 1`,
        agent
      ).first()
      if (task && !tasks.has(task.task_id)) void execute(task).catch((error) => console.error(error))
    }
    for (const [taskId, active] of tasks) {
      const row = await query('SELECT status FROM tasks WHERE id=?', taskId).first()
      if (row?.status === 'failed' || row?.status === 'cancelled') kill(active.child)
    }
  } catch (error) {
    console.error(`[local agents] ${error.message}`)
  } finally {
    polling = false
  }
}

async function shutdown() {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  for (const active of tasks.values()) kill(active.child)
  daemon?.kill('SIGTERM')
  frontend?.kill('SIGTERM')
  await delay(3500)
  await mf?.dispose()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

try {
  await mkdir(sandbox, { recursive: true, mode: 0o700 })
  const bundle = buildSync({
    entryPoints: [path.join(workerRoot, 'src/index.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['cloudflare:workers', 'node:*']
  }).outputFiles[0].text
  mf = new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate: '2026-01-01',
    compatibilityFlags: ['nodejs_compat'],
    host: '127.0.0.1',
    port: apiPort,
    defaultPersistRoot: path.join(runtime, 'storage'),
    d1Databases: ['DB'],
    d1Persist: true,
    kvNamespaces: ['POLL_CACHE', 'JWKS_CACHE', 'CB_KV'],
    kvPersist: true,
    r2Buckets: ['LOGS'],
    r2Persist: true,
    durableObjectsPersist: true,
    durableObjects: {
      GRAPH_COORDINATOR: { className: 'GraphCoordinator', useSQLite: true },
      AUTH_LIMITS: { className: 'AuthLimiter', useSQLite: true },
      TERMINAL_RELAY: { className: 'TerminalRelay' }
    },
    bindings: {
      ACTION_GRAPH_ENABLED: 'true',
      ALLOWED_ORIGINS: `${portalBase},http://localhost:${portalPort}`,
      FIREBASE_PROJECT_ID: 'local-graph',
      FIREBASE_SERVICE_ACCOUNT_KEY: '',
      DAEMON_SECRET: randomBytes(32).toString('hex'),
      R2_LOGS_MASTER_KEY: ''
    }
  })
  await mf.ready
  db = await mf.getD1Database('DB')
  await migrate()
  const graphId = await seed()
  const portalEnv = {
    ...process.env,
    VITE_API_BASE_URL: apiBase,
    VITE_ACTION_GRAPH_ENABLED: 'true',
    VITE_LOCAL_GRAPH_TOKEN: token,
    VITE_LOCAL_GRAPH_AGENTS: mode,
    VITE_FIREBASE_API_KEY: '',
    VITE_POSTHOG_KEY: ''
  }
  frontend = spawn(
    'bun',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(portalPort), '--strictPort'],
    { cwd: path.join(root, 'packages/portal'), env: portalEnv, stdio: ['ignore', 'inherit', 'inherit'] }
  )
  frontend.once('exit', (code) => {
    if (!stopping) {
      console.error(`Portal exited ${code}`)
      void shutdown()
    }
  })
  await writeFile(
    path.join(runtime, 'running.json'),
    JSON.stringify({
      pid: process.pid,
      api: apiBase,
      portal: portalBase,
      mode,
      teamId: ids.team,
      graphId,
      sandbox
    }),
    { mode: 0o600 }
  )
  console.log(
    `\nLocal Graph test environment (${mode} agents)\nPortal: ${portalBase}/dashboard/graphs/${graphId}\nAPI: ${apiBase}\nSandbox: ${sandbox}\nSample graph is Draft. Press Run to begin. Each role requires your review.\nCtrl+C stops this local environment; data persists in ${runtime}.\n`
  )
  if (mode === 'daemon') {
    const state = path.join(runtime, 'daemon-state')
    await mkdir(state, { recursive: true, mode: 0o700 })
    const configFile = path.join(runtime, 'daemon.toml')
    const adapter = path.join(root, 'packages/daemon/scripts/local-graph-daemon/claude.mjs')
    await writeFile(
      configFile,
      `[server]\nurl = "${apiBase}"\npoll_interval = 60\n[hooks]\nport = 17374\n[analytics]\nenabled = false\n` +
        [
          [ids.executor, 'Local Explorer'],
          [ids.grader, 'Local Reviewer']
        ]
          .map(
            ([id, name]) =>
              `[[agents]]\nid = "${id}"\nname = "${name}"\ncommand = "node ${adapter}${id === ids.grader ? ' --read-only' : ''}"\nprovider = "stdout"\nwork_dir = "${sandbox}"\n`
          )
          .join(''),
      { mode: 0o600 }
    )
    daemon = spawn(
      path.join(runtime, 'local-daemon'),
      ['--config', configFile, '--session', path.join(runtime, 'session.json')],
      { env: { ...process.env, TSQ_STATE_DIR: state }, stdio: ['ignore', 'inherit', 'inherit'] }
    )
    daemon.once('exit', (code) => {
      if (!stopping) {
        console.error(`Local daemon exited ${code}`)
        void shutdown()
      }
    })
  } else {
    await poll()
    timer = setInterval(() => {
      void poll()
    }, 1500)
  }
} catch (error) {
  console.error(error)
  daemon?.kill('SIGTERM')
  frontend?.kill('SIGTERM')
  await mf?.dispose()
  process.exit(1)
}

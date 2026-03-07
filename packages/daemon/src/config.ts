import { homedir } from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'

export interface AgentConfig {
  token: string    // tsq_... — identifies both agent and team
  name: string
  command: string
  workDir: string
}

export interface Config {
  apiUrl: string
  pollInterval: number   // seconds
  hooksPort: number
  agents: AgentConfig[]
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export function loadConfig(): Config {
  const configPath = join(homedir(), '.tasksquad', 'config.json')
  let fileConfig: Partial<Config & { agents: (Partial<AgentConfig> & { work_dir?: string })[] }> = {}

  try {
    fileConfig = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    // Fall back to env vars
  }

  const apiUrl       = process.env.TSQ_API_URL       ?? fileConfig.apiUrl       ?? 'https://tasksquad-api.xajik0.workers.dev'
  const hooksPort    = Number(process.env.TSQ_HOOKS_PORT    ?? fileConfig.hooksPort    ?? 7374)
  const pollInterval = Number(process.env.TSQ_POLL_INTERVAL ?? fileConfig.pollInterval ?? 10)

  const agents: AgentConfig[] = (fileConfig.agents ?? []).map(a => ({
    token:   a.token   ?? '',
    name:    a.name    ?? 'agent',
    command: a.command ?? 'claude --dangerously-skip-permissions',
    workDir: expandHome(a.workDir ?? a.work_dir ?? process.cwd()),
  }))

  // Single agent from env vars
  if (agents.length === 0) {
    const token   = process.env.TSQ_TOKEN
    const name    = process.env.TSQ_AGENT_NAME    ?? 'local-dev'
    const command = process.env.TSQ_AGENT_COMMAND ?? 'claude --dangerously-skip-permissions'
    const workDir = expandHome(process.env.TSQ_AGENT_WORK_DIR ?? process.cwd())

    if (token) agents.push({ token, name, command, workDir })
  }

  if (agents.length === 0) {
    throw new Error('No agents configured. Add agents to ~/.tasksquad/config.json or set TSQ_TOKEN env var.')
  }

  for (const a of agents) {
    if (!a.token) throw new Error(`Agent "${a.name}" is missing a token.`)
  }

  return { apiUrl, pollInterval, hooksPort, agents }
}

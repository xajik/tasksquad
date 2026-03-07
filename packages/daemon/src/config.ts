import { homedir } from 'os'
import { join } from 'path'

export interface AgentConfig {
  id: string
  name: string
  command: string
  workDir: string
}

export interface Config {
  apiUrl: string
  token: string
  teamId: string
  pollInterval: number   // seconds
  hooksPort: number
  agents: AgentConfig[]
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export function loadConfig(): Config {
  // 1. Try config file at ~/.tasksquad/config.json
  const configPath = join(homedir(), '.tasksquad', 'config.json')
  let fileConfig: Partial<Config & { agents: (AgentConfig & { work_dir?: string })[] }> = {}

  try {
    const raw = Bun.file(configPath).textSync()
    fileConfig = JSON.parse(raw)
  } catch {
    // Config file not found — fall back to env vars
  }

  const apiUrl     = process.env.TSQ_API_URL     ?? fileConfig.apiUrl     ?? 'https://tasksquad-api.xajik0.workers.dev'
  const token      = process.env.TSQ_TOKEN        ?? fileConfig.token      ?? ''
  const teamId     = process.env.TSQ_TEAM_ID      ?? fileConfig.teamId     ?? ''
  const hooksPort  = Number(process.env.TSQ_HOOKS_PORT  ?? fileConfig.hooksPort  ?? 7374)
  const pollInterval = Number(process.env.TSQ_POLL_INTERVAL ?? fileConfig.pollInterval ?? 10)

  if (!token)  throw new Error('TSQ_TOKEN is required (set in ~/.tasksquad/config.json or env)')
  if (!teamId) throw new Error('TSQ_TEAM_ID is required (set in ~/.tasksquad/config.json or env)')

  // Agents from config file — normalise work_dir → workDir
  const agents: AgentConfig[] = (fileConfig.agents ?? []).map(a => ({
    id:      a.id,
    name:    a.name,
    command: a.command,
    workDir: expandHome(a.workDir ?? a.work_dir ?? process.cwd()),
  }))

  // Single agent from env vars (convenience for quick demo)
  if (agents.length === 0) {
    const agentId      = process.env.TSQ_AGENT_ID
    const agentName    = process.env.TSQ_AGENT_NAME    ?? 'local-dev'
    const agentCommand = process.env.TSQ_AGENT_COMMAND ?? 'claude --dangerously-skip-permissions'
    const agentWorkDir = expandHome(process.env.TSQ_AGENT_WORK_DIR ?? process.cwd())

    if (agentId) {
      agents.push({ id: agentId, name: agentName, command: agentCommand, workDir: agentWorkDir })
    }
  }

  if (agents.length === 0) {
    throw new Error('No agents configured. Add agents to ~/.tasksquad/config.json or set TSQ_AGENT_ID env var.')
  }

  return { apiUrl, token, teamId, pollInterval, hooksPort, agents }
}

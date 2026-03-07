import { loadConfig } from './config.ts'
import { Agent } from './agent.ts'
import { startHookServer } from './hooks.ts'

async function main() {
  const cfg = loadConfig()

  console.log(`[tsq] TaskSquad daemon starting`)
  console.log(`[tsq] API: ${cfg.apiUrl}`)
  console.log(`[tsq] Agents: ${cfg.agents.map(a => a.name).join(', ')}`)
  console.log(`[tsq] Poll interval: ${cfg.pollInterval}s`)

  const agents = cfg.agents.map(a => new Agent(a))

  // Start hook server for Claude Code hooks (Stop, Notification)
  startHookServer(cfg, agents)

  // Run heartbeat loop for all agents
  async function tick() {
    await Promise.allSettled(agents.map(a => a.heartbeat(cfg)))
  }

  // Initial tick immediately
  await tick()

  // Then poll on interval
  setInterval(() => {
    tick().catch(err => console.error('[tsq] tick error:', err))
  }, cfg.pollInterval * 1000)

  console.log(`[tsq] Running — waiting for tasks...`)
}

main().catch(err => {
  console.error('[tsq] Fatal error:', err)
  process.exit(1)
})

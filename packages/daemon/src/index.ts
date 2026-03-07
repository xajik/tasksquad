import { loadConfig } from './config.ts'
import { Agent } from './agent.ts'
import { startHookServer } from './hooks.ts'
import { log } from './logger.ts'

async function main() {
  const cfg = loadConfig()

  log.info(`TaskSquad daemon starting`)
  log.info(`API: ${cfg.apiUrl}`)
  log.info(`Agents: ${cfg.agents.map(a => a.name).join(', ')}`)
  log.info(`Poll interval: ${cfg.pollInterval}s`)

  const agents = cfg.agents.map(a => new Agent(a))

  startHookServer(cfg, agents)

  let tickCount = 0

  async function tick() {
    tickCount++
    log.debug(`Tick #${tickCount} — polling ${agents.length} agent(s)`)
    await Promise.allSettled(agents.map(a => a.heartbeat(cfg)))
  }

  await tick()

  setInterval(() => {
    tick().catch(err => log.error(`tick error: ${err}`))
  }, cfg.pollInterval * 1000)

  log.info(`Running — waiting for tasks...`)
}

main().catch(err => {
  log.error(`Fatal error: ${err}`)
  process.exit(1)
})

import type { Config } from './config.ts'
import type { Agent } from './agent.ts'
import { log } from './logger.ts'

interface StopPayload {
  stop_reason?: string
  session_id?: string
}

interface NotificationPayload {
  message?: string
}

export function startHookServer(cfg: Config, agents: Agent[]): void {
  const port = cfg.hooksPort

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)

      if (req.method === 'POST' && url.pathname === '/hooks/stop') {
        const payload = await req.json().catch(() => ({})) as StopPayload
        log.info(`[hooks] Stop received: ${JSON.stringify(payload)}`)

        // Find the running agent and complete it
        const agent = agents.find(a => a.mode === 'running' || a.mode === 'waiting_input')
        if (agent) {
          agent.complete(cfg, 'closed').catch(err =>
            console.error('[hooks] complete error:', err)
          )
        }
        return new Response('ok')
      }

      if (req.method === 'POST' && url.pathname === '/hooks/notification') {
        const payload = await req.json().catch(() => ({})) as NotificationPayload
        const message = payload.message ?? 'Claude is waiting for your input'
        log.info(`[hooks] Notification received: ${message}`)

        // Find the running agent and move it to waiting_input
        const agent = agents.find(a => a.mode === 'running')
        if (agent) {
          agent.setWaitingInput(cfg, message).catch(err =>
            console.error('[hooks] setWaitingInput error:', err)
          )
        }
        return new Response('ok')
      }

      return new Response('not found', { status: 404 })
    },
  })

  log.info(`[hooks] Server listening on http://localhost:${server.port}`)
}

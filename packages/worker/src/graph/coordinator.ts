import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types.js'
import { run, tick } from './engine.js'
import { maintenance } from './maintenance.js'
import { materialize } from './outbox.js'
import type { Data } from './store.js'

export class GraphCoordinator extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve()
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work)
    this.tail = next.catch(() => undefined)
    return next
  }
  async command(graphId: string, command: string, body: Data = {}): Promise<void> {
    return this.serial(async () => {
      if (
        this.env.ACTION_GRAPH_ENABLED !== 'true' &&
        !['tick', 'pause', 'stop', 'review', 'input'].includes(command)
      )
        throw new Error('Action Graph dispatch is disabled')
      await this.ctx.storage.put('team_id', body.team_id)
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
      if (command !== 'tick') await run(this.env.DB, graphId, command, body)
      await maintenance(this.env, graphId)
      await tick(this.env, graphId)
      await this.ctx.storage.setAlarm(Date.now() + 30_000)
    })
  }
  async alarm(): Promise<void> {
    return this.serial(async () => {
      if (this.env.ACTION_GRAPH_ENABLED === undefined) return
      const team = await this.ctx.storage.get<string>('team_id')
      if (!team) return
      const graphs = await this.env.DB.prepare('SELECT id FROM graphs WHERE team_id=?')
        .bind(team)
        .all<{ id: string }>()
      try {
        for (const g of graphs.results) {
          try {
            await maintenance(this.env, g.id)
            await tick(this.env, g.id)
            await materialize(this.env, g.id)
          } catch (error) {
            console.error(
              JSON.stringify({ event: 'graph_wake_failed', graph_id: g.id, error: String(error) })
            )
          }
        }
      } finally {
        await this.ctx.storage.setAlarm(Date.now() + 30_000)
      }
    })
  }
}

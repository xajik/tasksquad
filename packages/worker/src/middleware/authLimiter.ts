// AuthLimiter — Durable Object holding one exact fixed-window counter. One instance per
// "<bucket>:<client IP>" (rateLimit.ts). Used where the Workers Rate Limiting binding's
// per-machine, eventually consistent counts are too loose: failed authentications and
// the token endpoints. It only sees those requests, never ordinary API traffic.

export interface Window {
  start: number
  count: number
}

// hit advances a fixed window by one request and reports whether it is within limit.
export function hit(window: Window | undefined, now: number, windowMs: number, limit: number): { window: Window; allowed: boolean } {
  const current = window && now - window.start < windowMs ? window : { start: now, count: 0 }
  const next = { start: current.start, count: current.count + 1 }
  return { window: next, allowed: next.count <= limit }
}

export class AuthLimiter implements DurableObject {
  constructor(private state: DurableObjectState) {}

  // POST /hit?limit=<n>&window=<ms> → { allowed }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const limit = Number(url.searchParams.get('limit'))
    const windowMs = Number(url.searchParams.get('window'))
    if (!(limit > 0) || !(windowMs > 0)) return new Response('bad limiter request', { status: 400 })

    const now = Date.now()
    const stored = await this.state.storage.get<Window>('window')
    const { window, allowed } = hit(stored, now, windowMs, limit)
    await this.state.storage.put('window', window)
    // Drop the counter once its window has passed, so idle IPs leave nothing behind.
    if (window.start !== stored?.start) await this.state.storage.setAlarm(window.start + windowMs)
    return Response.json({ allowed })
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }
}
